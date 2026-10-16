use crate::{Host, HostError, FILE_PLUGIN};
use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use nexttools_protocol::{FileChange, FileChangeApproval, FileChangeKind};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    path::{Component, Path},
    time::{Duration, Instant},
};

pub(crate) struct PendingFileChange {
    workspace: String,
    change: FileChange,
    digest: String,
    expires: Instant,
    root: Dir,
}
fn action(change: &FileChange) -> &'static str {
    match change.kind {
        FileChangeKind::Write => "files.write",
        FileChangeKind::Create => "files.create",
        FileChangeKind::Delete => "files.delete",
    }
}
fn invalid(message: &str) -> HostError {
    HostError::Invalid(message.into())
}
fn validate(change: &FileChange) -> Result<(), HostError> {
    if change.path.is_empty()
        || change.path.contains(['\\', ':'])
        || Path::new(&change.path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err(invalid("只允许工作区内的相对文件路径"));
    }
    for text in [&change.content, &change.expected_content]
        .into_iter()
        .flatten()
    {
        if text.len() > 1_048_576 || text.contains('\0') {
            return Err(invalid("仅支持 1 MiB 内的 UTF-8 文本"));
        }
    }
    match change.kind {
        FileChangeKind::Create if change.content.is_some() && change.expected_content.is_none() => {
            Ok(())
        }
        FileChangeKind::Write if change.content.is_some() && change.expected_content.is_some() => {
            Ok(())
        }
        FileChangeKind::Delete if change.content.is_none() && change.expected_content.is_some() => {
            Ok(())
        }
        _ => Err(invalid("文件操作参数不完整")),
    }
}
fn check(root: &Dir, change: &FileChange) -> Result<(), HostError> {
    match root.symlink_metadata(&change.path) {
        Ok(metadata) => {
            if matches!(change.kind, FileChangeKind::Create) {
                return Err(invalid("文件已存在"));
            }
            if !metadata.is_file() || metadata.file_type().is_symlink() {
                return Err(invalid("仅支持普通文件，不允许符号链接"));
            }
        }
        Err(e)
            if e.kind() == std::io::ErrorKind::NotFound
                && matches!(change.kind, FileChangeKind::Create) =>
        {
            return Ok(())
        }
        Err(e) => return Err(e.into()),
    }
    let mut bytes = Vec::new();
    root.open(&change.path)?
        .take(1_048_577)
        .read_to_end(&mut bytes)?;
    if Some(bytes.as_slice()) != change.expected_content.as_ref().map(|s| s.as_bytes()) {
        return Err(invalid("文件已在外部发生变化，请重新加载"));
    }
    Ok(())
}
impl Host {
    pub fn prepare_file_change(
        &mut self,
        workspace: &str,
        change: FileChange,
    ) -> Result<FileChangeApproval, HostError> {
        let id = uuid::Uuid::new_v4().to_string();
        let digest = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&(workspace, FILE_PLUGIN, &change))?)
        );
        let result = (|| {
            capability_broker::authorize_approved(
                &self.manifest,
                self.store.plugin_enabled(FILE_PLUGIN)?,
                "workspace.write",
                true,
            )?;
            let workspace = self.workspace(workspace)?;
            validate(&change)?;
            let root = Dir::open_ambient_dir(&workspace.root, ambient_authority())?;
            check(&root, &change)?;
            Ok::<_, HostError>(root)
        })();
        self.store.audit_file(
            workspace,
            action(&change),
            if result.is_ok() { "pending" } else { "denied" },
            &id,
            &digest,
        )?;
        let root = result?;
        let expired: Vec<_> = self
            .file_changes
            .iter()
            .filter(|(_, p)| p.expires <= Instant::now())
            .map(|(id, _)| id.clone())
            .collect();
        for expired_id in expired {
            if let Some(p) = self.file_changes.remove(&expired_id) {
                self.store.audit_file(
                    &p.workspace,
                    action(&p.change),
                    "cancelled",
                    &expired_id,
                    &p.digest,
                )?;
            }
        }
        if self.file_changes.len() >= 64 {
            return Err(invalid("待审批文件操作过多"));
        }
        let diff = similar::TextDiff::from_lines(
            change.expected_content.as_deref().unwrap_or(""),
            change.content.as_deref().unwrap_or(""),
        )
        .unified_diff()
        .header(&format!("a/{}", change.path), &format!("b/{}", change.path))
        .to_string();
        let approval = FileChangeApproval {
            request_id: id.clone(),
            change: change.clone(),
            diff,
            expires_in_seconds: 120,
        };
        self.file_changes.insert(
            id,
            PendingFileChange {
                workspace: workspace.into(),
                change,
                digest,
                expires: Instant::now() + Duration::from_secs(120),
                root,
            },
        );
        Ok(approval)
    }
    pub fn resolve_file_change(
        &mut self,
        workspace: &str,
        id: &str,
        approved: bool,
    ) -> Result<(), HostError> {
        let pending = self
            .file_changes
            .get(id)
            .ok_or_else(|| invalid("审批已处理或失效"))?;
        if pending.workspace != workspace {
            return Err(invalid("审批不属于当前工作区"));
        }
        let pending = self
            .file_changes
            .remove(id)
            .ok_or_else(|| invalid("审批已处理或失效"))?;
        if !approved || Instant::now() >= pending.expires {
            self.store.audit_file(
                workspace,
                action(&pending.change),
                "cancelled",
                id,
                &pending.digest,
            )?;
            return if approved {
                Err(invalid("审批已过期"))
            } else {
                Ok(())
            };
        }
        let result = (|| {
            capability_broker::authorize_approved(
                &self.manifest,
                self.store.plugin_enabled(FILE_PLUGIN)?,
                "workspace.write",
                true,
            )?;
            self.workspace(workspace)?;
            check(&pending.root, &pending.change)?;
            // Persist the approval before touching the filesystem. Never trust UI-supplied parameters at execution.
            self.store.audit_file(
                workspace,
                action(&pending.change),
                "approved",
                id,
                &pending.digest,
            )?;
            match pending.change.kind {
                FileChangeKind::Delete => pending.root.remove_file(&pending.change.path)?,
                FileChangeKind::Create => {
                    let mut options = OpenOptions::new();
                    options.write(true).create_new(true);
                    let mut file = pending.root.open_with(&pending.change.path, &options)?;
                    file.write_all(pending.change.content.as_deref().unwrap_or("").as_bytes())?;
                    file.sync_all()?;
                }
                FileChangeKind::Write => {
                    let parent = Path::new(&pending.change.path)
                        .parent()
                        .unwrap_or(Path::new(""));
                    let temp = parent.join(format!(".nexttools-{}.tmp", uuid::Uuid::new_v4()));
                    let mut options = OpenOptions::new();
                    options.write(true).create_new(true);
                    let result = (|| -> Result<(), HostError> {
                        let mut file = pending.root.open_with(&temp, &options)?;
                        file.write_all(pending.change.content.as_deref().unwrap_or("").as_bytes())?;
                        file.set_permissions(
                            pending.root.metadata(&pending.change.path)?.permissions(),
                        )?;
                        file.sync_all()?;
                        drop(file);
                        check(&pending.root, &pending.change)?;
                        pending
                            .root
                            .rename(&temp, &pending.root, &pending.change.path)?;
                        Ok(())
                    })();
                    if result.is_err() {
                        let _ = pending.root.remove_file(&temp);
                    }
                    result?;
                }
            }
            Ok::<_, HostError>(())
        })();
        self.store.audit_file(
            workspace,
            action(&pending.change),
            if result.is_ok() { "allowed" } else { "failed" },
            id,
            &pending.digest,
        )?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        host: Host,
        workspace: String,
        root: tempfile::TempDir,
    }
    impl Fixture {
        fn new() -> Self {
            let root = tempfile::Builder::new()
                .prefix("nexttools-files-")
                .tempdir()
                .unwrap();
            std::fs::create_dir_all(root.path().join("workspace")).unwrap();
            let mut host = Host::open(&root.path().join("host.sqlite3")).unwrap();
            let workspace = host
                .add_workspace(&root.path().join("workspace"))
                .unwrap()
                .id;
            Self {
                host,
                workspace,
                root,
            }
        }
        fn change(
            &mut self,
            kind: FileChangeKind,
            content: Option<&str>,
            expected: Option<&str>,
        ) -> FileChangeApproval {
            self.host
                .prepare_file_change(
                    &self.workspace,
                    FileChange {
                        kind,
                        path: "sample.txt".into(),
                        content: content.map(str::to_owned),
                        expected_content: expected.map(str::to_owned),
                    },
                )
                .unwrap()
        }
        fn resolve(&mut self, id: &str, approved: bool) -> Result<(), HostError> {
            self.host.resolve_file_change(&self.workspace, id, approved)
        }
        fn path(&self) -> std::path::PathBuf {
            self.root.path().join("workspace/sample.txt")
        }
        fn decisions(&self, id: &str) -> Vec<String> {
            let conn = rusqlite::Connection::open(self.root.path().join("host.sqlite3")).unwrap();
            let mut query = conn
                .prepare("SELECT decision FROM audit_events WHERE request_id = ?1 ORDER BY rowid")
                .unwrap();
            query
                .query_map([id], |row| row.get(0))
                .unwrap()
                .collect::<Result<_, _>>()
                .unwrap()
        }
    }
    #[test]
    fn approved_crud_has_diff_single_use_tokens_and_audit() {
        let mut f = Fixture::new();
        let create = f.change(FileChangeKind::Create, Some("before\n"), None);
        assert!(!f.path().exists());
        assert!(create.diff.contains("+before"));
        f.resolve(&create.request_id, true).unwrap();
        assert_eq!(std::fs::read_to_string(f.path()).unwrap(), "before\n");
        assert_eq!(
            f.decisions(&create.request_id),
            ["pending", "approved", "allowed"]
        );
        assert!(f.resolve(&create.request_id, true).is_err());
        let write = f.change(FileChangeKind::Write, Some("after\n"), Some("before\n"));
        assert!(write.diff.contains("-before"));
        assert!(write.diff.contains("+after"));
        f.resolve(&write.request_id, true).unwrap();
        assert_eq!(std::fs::read_to_string(f.path()).unwrap(), "after\n");
        let delete = f.change(FileChangeKind::Delete, None, Some("after\n"));
        f.resolve(&delete.request_id, true).unwrap();
        assert!(!f.path().exists());
        assert_eq!(
            f.decisions(&delete.request_id),
            ["pending", "approved", "allowed"]
        );
    }

    #[test]
    fn rejection_and_expiry_never_create_files() {
        let mut f = Fixture::new();
        let rejected = f.change(FileChangeKind::Create, Some("secret"), None);
        f.resolve(&rejected.request_id, false).unwrap();
        assert!(f.resolve(&rejected.request_id, true).is_err());
        assert_eq!(f.decisions(&rejected.request_id), ["pending", "cancelled"]);
        let expired = f.change(FileChangeKind::Create, Some("secret"), None);
        f.host
            .file_changes
            .get_mut(&expired.request_id)
            .unwrap()
            .expires = Instant::now();
        assert!(f.resolve(&expired.request_id, true).is_err());
        assert_eq!(f.decisions(&expired.request_id), ["pending", "cancelled"]);
        assert!(!f.path().exists());
    }

    #[test]
    fn external_changes_prevent_write_and_delete() {
        let mut f = Fixture::new();
        for kind in [FileChangeKind::Write, FileChangeKind::Delete] {
            std::fs::write(f.path(), "original").unwrap();
            let content = matches!(kind, FileChangeKind::Write).then_some("replacement");
            let pending = f.change(kind, content, Some("original"));
            std::fs::write(f.path(), "external update").unwrap();
            assert!(f.resolve(&pending.request_id, true).is_err());
            assert_eq!(
                std::fs::read_to_string(f.path()).unwrap(),
                "external update"
            );
            assert_eq!(f.decisions(&pending.request_id), ["pending", "failed"]);
        }
    }

    #[test]
    fn revoked_plugin_permission_blocks_pending_approval() {
        let mut f = Fixture::new();
        let pending = f.change(FileChangeKind::Create, Some("data"), None);
        f.host.set_plugin_enabled(FILE_PLUGIN, false).unwrap();
        assert!(f.resolve(&pending.request_id, true).is_err());
        assert_eq!(f.decisions(&pending.request_id), ["pending", "failed"]);
        assert!(!f.path().exists());
        assert!(f
            .host
            .prepare_file_change(&f.workspace, pending.change)
            .is_err());
    }

    #[test]
    fn approval_cannot_be_used_for_a_different_workspace() {
        let mut f = Fixture::new();
        let other = f.host.add_workspace(f.root.path()).unwrap().id;
        let pending = f.change(FileChangeKind::Create, Some("data"), None);
        assert!(f
            .host
            .resolve_file_change(&other, &pending.request_id, true)
            .is_err());
        assert!(!f.path().exists());
        f.resolve(&pending.request_id, true).unwrap();
        assert_eq!(std::fs::read_to_string(f.path()).unwrap(), "data");
    }

    #[test]
    fn unsafe_paths_oversized_text_and_duplicate_creation_are_rejected() {
        let mut f = Fixture::new();
        for path in [
            "../escape.txt",
            "/absolute.txt",
            "C:/outside.txt",
            "folder\\escape.txt",
            "",
        ] {
            assert!(f
                .host
                .prepare_file_change(
                    &f.workspace,
                    FileChange {
                        kind: FileChangeKind::Create,
                        path: path.into(),
                        content: Some("data".into()),
                        expected_content: None,
                    }
                )
                .is_err());
        }
        let pending = f.change(FileChangeKind::Create, Some("data"), None);
        f.resolve(&pending.request_id, true).unwrap();
        assert!(f
            .host
            .prepare_file_change(&f.workspace, pending.change)
            .is_err());
        assert!(f
            .host
            .prepare_file_change(
                &f.workspace,
                FileChange {
                    kind: FileChangeKind::Create,
                    path: "large.txt".into(),
                    content: Some("x".repeat(1_048_577)),
                    expected_content: None,
                }
            )
            .is_err());
        assert_eq!(std::fs::read_to_string(f.path()).unwrap(), "data");
    }
}
