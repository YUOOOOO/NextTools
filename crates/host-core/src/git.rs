use crate::{Host, HostError, AGENT_PLUGIN};
use nexttools_protocol::{GitAction, GitApproval, GitChange, GitQuery, GitStatus};
use sha2::{Digest, Sha256};
use std::{
    path::{Component, Path, PathBuf},
    process::Command,
    sync::atomic::AtomicBool,
    time::{Duration, Instant},
};

pub(crate) struct PendingGitAction {
    workspace: String,
    action: GitAction,
    digest: String,
    expires: Instant,
    stash: Option<String>,
}
fn invalid(text: &str) -> HostError {
    HostError::Invalid(text.into())
}
fn capability(action: &GitAction) -> &'static str {
    match action {
        GitAction::Commit { .. } | GitAction::Merge { .. } | GitAction::MergeContinue => {
            "git.commit"
        }
        GitAction::Push { .. } | GitAction::Fetch | GitAction::Pull => "git.push",
        _ => "workspace.write",
    }
}
fn paths(values: &[String]) -> Result<(), HostError> {
    if values.is_empty() || values.len() > 1000 {
        return Err(invalid("请选择 1–1000 个文件"));
    }
    for value in values {
        if value.is_empty()
            || value.contains('\0')
            || value.contains('\\')
            || value
                .split('/')
                .any(|part| part.eq_ignore_ascii_case(".git"))
            || Path::new(value)
                .components()
                .any(|c| !matches!(c, Component::Normal(_)))
        {
            return Err(invalid("Git 只允许工作区内相对路径"));
        }
    }
    Ok(())
}
fn reference(value: &str) -> Result<(), HostError> {
    if value.is_empty()
        || value.starts_with('-')
        || value.len() > 512
        || value.chars().any(char::is_control)
    {
        return Err(invalid("Git 引用无效"));
    }
    Ok(())
}
fn arguments(action: &GitAction) -> Result<Vec<String>, HostError> {
    let mut args: Vec<String> = match action {
        GitAction::Stage { paths: p } => {
            paths(p)?;
            vec!["add", "--"]
        }
        GitAction::Unstage { paths: p } => {
            paths(p)?;
            vec!["restore", "--staged", "--"]
        }
        GitAction::Discard { paths: p } => {
            paths(p)?;
            vec!["restore", "--worktree", "--"]
        }
        GitAction::Commit { message } => {
            if message.trim().is_empty() || message.len() > 32000 || message.contains('\0') {
                return Err(invalid("提交信息不能为空且不得超过 32 KiB"));
            }
            vec!["commit", "-m"]
        }
        GitAction::Switch { branch }
        | GitAction::CreateBranch { branch }
        | GitAction::SwitchRemote { branch }
        | GitAction::Merge { branch } => {
            reference(branch)?;
            match action {
                GitAction::CreateBranch { .. } => vec!["switch", "--no-track", "-c"],
                GitAction::SwitchRemote { .. } => vec!["switch", "--track"],
                GitAction::Merge { .. } => vec!["merge", "--no-edit", "--"],
                _ => vec!["switch"],
            }
        }
        GitAction::Fetch => vec!["fetch", "--all", "--prune"],
        GitAction::Pull => vec!["pull", "--no-rebase", "--no-edit"],
        GitAction::Push { remote } => {
            if let Some(remote) = remote {
                reference(remote)?;
            }
            vec!["push"]
        }
        GitAction::StashSave { message } => {
            if message.len() > 32000 || message.contains('\0') {
                return Err(invalid("Stash 信息无效"));
            }
            vec!["stash", "push", "-u", "-m"]
        }
        GitAction::StashApply { reference: r } | GitAction::StashDrop { reference: r } => {
            if !r.starts_with("stash@{")
                || !r.ends_with('}')
                || r.len() <= 8
                || !r[7..r.len() - 1].bytes().all(|b| b.is_ascii_digit())
            {
                return Err(invalid("Stash 引用无效"));
            }
            if matches!(action, GitAction::StashApply { .. }) {
                vec!["stash", "apply"]
            } else {
                vec!["stash", "drop"]
            }
        }
        GitAction::MergeContinue => vec!["commit", "--no-edit"],
        GitAction::Abort => vec![],
        GitAction::Reset { commit, hard } => {
            if !matches!(commit.len(), 40 | 64) || !commit.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(invalid("回退目标必须是完整提交哈希"));
            }
            if *hard {
                vec!["reset", "--hard"]
            } else {
                vec!["reset", "--mixed"]
            }
        }
        GitAction::ResolveConflict { path, theirs } => {
            paths(std::slice::from_ref(path))?;
            if *theirs {
                vec!["checkout", "--theirs", "--"]
            } else {
                vec!["checkout", "--ours", "--"]
            }
        }
    }
    .into_iter()
    .map(str::to_owned)
    .collect();
    match action {
        GitAction::Stage { paths }
        | GitAction::Unstage { paths }
        | GitAction::Discard { paths } => args.extend(paths.iter().cloned()),
        GitAction::Commit { message } | GitAction::StashSave { message } => {
            args.push(message.clone())
        }
        GitAction::Switch { branch }
        | GitAction::CreateBranch { branch }
        | GitAction::SwitchRemote { branch }
        | GitAction::Merge { branch } => args.push(branch.clone()),
        GitAction::StashApply { reference } | GitAction::StashDrop { reference } => {
            args.push(reference.clone())
        }
        GitAction::Reset { commit, .. } => args.push(commit.clone()),
        GitAction::ResolveConflict { path, .. } => args.push(path.clone()),
        _ => {}
    }
    Ok(args)
}
impl Host {
    fn git_output(&self, workspace: &str, args: &[String]) -> Result<String, HostError> {
        let ws = self.workspace(workspace)?;
        let root = Path::new(&ws.root).canonicalize()?;
        if let Some(index) = args.iter().position(|s| s == "--").filter(|_| {
            matches!(
                args.first().map(String::as_str),
                Some("add" | "rm" | "restore" | "checkout" | "diff")
            )
        }) {
            for arg in &args[index + 1..] {
                if Path::new(arg).is_absolute() {
                    return Err(invalid("Git 路径必须是相对路径"));
                }
                let mut target = root.clone();
                for part in Path::new(arg).components() {
                    if !matches!(part, Component::Normal(_)) {
                        return Err(invalid("Git 路径越界"));
                    }
                    target.push(part);
                    if let Ok(meta) = std::fs::symlink_metadata(&target) {
                        if meta.file_type().is_symlink() {
                            return Err(invalid("Git 路径不得穿过符号链接"));
                        }
                    }
                }
            }
        }
        let mut command = Command::new("git");
        command.current_dir(&root);
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(key);
            }
        }
        command
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_LITERAL_PATHSPECS", "1")
            .env("GIT_OPTIONAL_LOCKS", "0")
            .env("GIT_EDITOR", "true")
            .args([
                "-c",
                "core.hooksPath=",
                "-c",
                "core.fsmonitor=false",
                "-c",
                "credential.interactive=false",
                "-c",
                "commit.gpgSign=false",
                "-c",
                "tag.gpgSign=false",
            ])
            .args(args);
        let result = crate::agent_tools::output(command, &AtomicBool::new(false))?;
        Ok(format!(
            "{}{}",
            result["stdout"].as_str().unwrap_or(""),
            result["stderr"].as_str().unwrap_or("")
        ))
    }
    fn git_repository(&self, workspace: &str) -> Result<PathBuf, HostError> {
        let root = Path::new(&self.workspace(workspace)?.root).canonicalize()?;
        let toplevel =
            self.git_output(workspace, &["rev-parse".into(), "--show-toplevel".into()])?;
        if Path::new(toplevel.trim()).canonicalize()? != root {
            return Err(invalid("请选择 Git 仓库根目录作为工作区"));
        }
        Ok(root)
    }
    fn git_state(&self, workspace: &str) -> Result<String, HostError> {
        for (marker, state) in [
            ("MERGE_HEAD", "merge"),
            ("rebase-merge", "rebase"),
            ("rebase-apply", "rebase"),
            ("CHERRY_PICK_HEAD", "cherry-pick"),
            ("REVERT_HEAD", "revert"),
        ] {
            let path = self.git_output(
                workspace,
                &["rev-parse".into(), "--git-path".into(), marker.into()],
            )?;
            let path = PathBuf::from(path.trim());
            if Path::new(&self.workspace(workspace)?.root)
                .join(path)
                .exists()
            {
                return Ok(state.into());
            }
        }
        Ok(String::new())
    }
    pub fn git_status(&self, workspace: &str) -> Result<GitStatus, HostError> {
        self.authorize_agent(workspace)?;
        self.git_repository(workspace)?;
        let text = self.git_output(
            workspace,
            &[
                "status".into(),
                "--porcelain=v1".into(),
                "-z".into(),
                "--branch".into(),
            ],
        )?;
        let mut records = text.split('\0');
        let branch = records
            .next()
            .unwrap_or("")
            .trim_start_matches("## ")
            .to_owned();
        let mut changes = Vec::new();
        while let Some(record) = records.next() {
            if record.len() < 4 {
                continue;
            }
            let index_status = record[..1].to_owned();
            let worktree_status = record[1..2].to_owned();
            let path = record[3..].to_owned();
            let original_path = if matches!(index_status.as_str(), "R" | "C")
                || matches!(worktree_status.as_str(), "R" | "C")
            {
                records.next().map(str::to_owned)
            } else {
                None
            };
            changes.push(GitChange {
                index_status,
                worktree_status,
                path,
                original_path,
            });
        }
        Ok(GitStatus {
            branch,
            changes,
            state: self.git_state(workspace)?,
        })
    }
    pub fn git_query(&self, workspace: &str, query: GitQuery) -> Result<String, HostError> {
        self.authorize_agent(workspace)?;
        self.git_repository(workspace)?;
        let args = match query {
            GitQuery::Diff { path, staged } => {
                paths(std::slice::from_ref(&path))?;
                let mut args = vec![
                    "diff".into(),
                    "--no-ext-diff".into(),
                    "--no-textconv".into(),
                ];
                if staged {
                    args.push("--cached".into());
                }
                args.extend(["--".into(), path]);
                args
            }
            GitQuery::Log => vec![
                "log".into(),
                "-50".into(),
                "--format=%H %s%n  %an · %aI".into(),
            ],
            GitQuery::Branches => vec![
                "branch".into(),
                "-a".into(),
                "-vv".into(),
                "--no-color".into(),
            ],
            GitQuery::Stashes => vec!["stash".into(), "list".into(), "--format=%gd %s".into()],
            GitQuery::Compare { left, right } => {
                reference(&left)?;
                reference(&right)?;
                vec![
                    "diff".into(),
                    "--no-ext-diff".into(),
                    "--no-textconv".into(),
                    left,
                    right,
                    "--".into(),
                ]
            }
            GitQuery::Show { commit } => {
                reference(&commit)?;
                vec![
                    "show".into(),
                    "--no-ext-diff".into(),
                    "--no-textconv".into(),
                    "--format=fuller".into(),
                    commit,
                    "--".into(),
                ]
            }
            GitQuery::Outgoing => vec![
                "log".into(),
                "--oneline".into(),
                "@{upstream}..HEAD".into(),
                "--".into(),
            ],
        };
        self.git_output(workspace, &args)
    }
    pub fn prepare_git_action(
        &mut self,
        workspace: &str,
        action: GitAction,
    ) -> Result<GitApproval, HostError> {
        self.authorize_agent(workspace)?;
        self.git_repository(workspace)?;
        arguments(&action)?;
        let stash = match &action {
            GitAction::StashApply { reference } | GitAction::StashDrop { reference } => Some(
                self.git_output(
                    workspace,
                    &["rev-parse".into(), "--verify".into(), reference.clone()],
                )?
                .trim()
                .to_owned(),
            ),
            _ => None,
        };
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(workspace, AGENT_PLUGIN, &action))?)
        );
        let request_id = uuid::Uuid::new_v4().to_string();
        self.store
            .audit_git(workspace, "git.prepare", "pending", &request_id, &digest)?;
        self.git_actions
            .retain(|_, value| value.expires > Instant::now());
        self.git_actions.insert(
            request_id.clone(),
            PendingGitAction {
                workspace: workspace.into(),
                action: action.clone(),
                digest,
                expires: Instant::now() + Duration::from_secs(300),
                stash,
            },
        );
        Ok(GitApproval {
            request_id,
            action,
            expires_in_seconds: 300,
        })
    }
    pub fn resolve_git_action(
        &mut self,
        workspace: &str,
        request: &str,
        approved: bool,
    ) -> Result<String, HostError> {
        if !self
            .git_actions
            .get(request)
            .is_some_and(|p| p.workspace == workspace)
        {
            return Err(invalid("Git 审批不存在或工作区不匹配"));
        }
        let pending = self.git_actions.remove(request).unwrap();
        if !approved {
            self.store
                .audit_git(workspace, "git.resolve", "denied", request, &pending.digest)?;
            return Ok("已拒绝，未执行 Git 操作".into());
        }
        let result = (|| {
            if pending.expires <= Instant::now() {
                return Err(invalid("Git 审批已过期"));
            }
            capability_broker::authorize_approved(
                &self.agent_manifest,
                self.store.plugin_enabled(AGENT_PLUGIN)?,
                capability(&pending.action),
                true,
            )?;
            self.git_repository(workspace)?;
            let mut args = arguments(&pending.action)?;
            if let Some(expected) = &pending.stash {
                let reference = args.last().unwrap();
                let actual = self.git_output(
                    workspace,
                    &["rev-parse".into(), "--verify".into(), reference.clone()],
                )?;
                if actual.trim() != expected {
                    return Err(invalid("Stash 列表已变化，请重新审批"));
                }
            }
            match &pending.action {
                GitAction::Unstage { paths }
                    if self
                        .git_output(
                            workspace,
                            &["rev-parse".into(), "--verify".into(), "HEAD".into()],
                        )
                        .is_err() =>
                {
                    args = vec![
                        "rm".into(),
                        "--cached".into(),
                        "-r".into(),
                        "--ignore-unmatch".into(),
                        "--".into(),
                    ];
                    args.extend(paths.iter().cloned());
                }
                GitAction::Push { remote } => {
                    if self
                        .git_output(
                            workspace,
                            &["rev-parse".into(), "--verify".into(), "@{upstream}".into()],
                        )
                        .is_err()
                    {
                        let branch = self
                            .git_output(workspace, &["branch".into(), "--show-current".into()])?;
                        if branch.trim().is_empty() {
                            return Err(invalid("游离 HEAD 不能发布分支"));
                        }
                        let remote = remote.as_deref().unwrap_or("origin");
                        let remotes = self.git_output(workspace, &["remote".into()])?;
                        if !remotes.lines().any(|r| r == remote) {
                            return Err(invalid("未配置该远端仓库"));
                        }
                        args.extend(["--set-upstream".into(), remote.into(), branch.trim().into()]);
                    }
                }
                GitAction::Abort => {
                    let state = self.git_state(workspace)?;
                    if state.is_empty() {
                        return Err(invalid("没有可中止的 Git 操作"));
                    }
                    args = vec![state, "--abort".into()];
                }
                GitAction::MergeContinue if self.git_state(workspace)? != "merge" => {
                    return Err(invalid("没有待完成的合并"))
                }
                _ => {}
            }
            let output = self.git_output(workspace, &args)?;
            if let GitAction::ResolveConflict { path, .. } = &pending.action {
                self.git_output(workspace, &["add".into(), "--".into(), path.clone()])?;
            }
            Ok(output)
        })();
        self.store.audit_git(
            workspace,
            "git.execute",
            if result.is_ok() { "allowed" } else { "failed" },
            request,
            &pending.digest,
        )?;
        result
    }
}

#[cfg(test)]
mod tests;
