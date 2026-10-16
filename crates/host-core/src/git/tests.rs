use super::*;

struct Fixture {
    host: Host,
    id: String,
    root: tempfile::TempDir,
    repo: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let repo = root.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        git(&repo, &["config", "user.name", "NextTools Test"]);
        git(
            &repo,
            &["config", "user.email", "nexttools@example.invalid"],
        );
        git(&repo, &["config", "core.autocrlf", "false"]);
        let mut host = Host::open(&root.path().join("host.sqlite")).unwrap();
        let id = host.add_workspace(&repo).unwrap().id;
        Self {
            host,
            id,
            root,
            repo,
        }
    }
    fn write(&self, text: &str) {
        std::fs::write(self.repo.join("file.txt"), text).unwrap();
    }
    fn act(&mut self, action: GitAction) -> Result<String, HostError> {
        let approval = self.host.prepare_git_action(&self.id, action)?;
        self.host
            .resolve_git_action(&self.id, &approval.request_id, true)
    }
    fn commit(&mut self, text: &str, message: &str) -> String {
        self.write(text);
        self.act(GitAction::Stage {
            paths: vec!["file.txt".into()],
        })
        .unwrap();
        self.act(GitAction::Commit {
            message: message.into(),
        })
        .unwrap();
        git(&self.repo, &["rev-parse", "HEAD"]).trim().to_owned()
    }
}
fn git(path: &Path, args: &[&str]) -> String {
    let output = Command::new("git")
        .current_dir(path)
        .args(["-c", "core.hooksPath=", "-c", "commit.gpgSign=false"])
        .args(args)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{args:?}: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

#[test]
fn initial_stage_unstage_commit_diff_and_discard() {
    let mut f = Fixture::new();
    f.write("one\n");
    f.act(GitAction::Stage {
        paths: vec!["file.txt".into()],
    })
    .unwrap();
    f.act(GitAction::Unstage {
        paths: vec!["file.txt".into()],
    })
    .unwrap();
    assert_eq!(
        f.host.git_status(&f.id).unwrap().changes[0].index_status,
        "?"
    );
    f.commit("one\n", "initial");
    f.write("two\n");
    assert!(f
        .host
        .git_query(
            &f.id,
            GitQuery::Diff {
                path: "file.txt".into(),
                staged: false
            }
        )
        .unwrap()
        .contains("+two"));
    f.act(GitAction::Stage {
        paths: vec!["file.txt".into()],
    })
    .unwrap();
    assert!(f
        .host
        .git_query(
            &f.id,
            GitQuery::Diff {
                path: "file.txt".into(),
                staged: true
            }
        )
        .unwrap()
        .contains("+two"));
    f.act(GitAction::Unstage {
        paths: vec!["file.txt".into()],
    })
    .unwrap();
    f.act(GitAction::Discard {
        paths: vec!["file.txt".into()],
    })
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("file.txt")).unwrap(),
        "one\n"
    );
    assert!(f.host.git_status(&f.id).unwrap().changes.is_empty());
}

#[test]
fn approval_denial_replay_expiry_revocation_and_workspace_binding() {
    let mut f = Fixture::new();
    f.write("private content\n");
    let action = || GitAction::Stage {
        paths: vec!["file.txt".into()],
    };
    let approval = f.host.prepare_git_action(&f.id, action()).unwrap();
    let other = f.root.path().join("other");
    std::fs::create_dir(&other).unwrap();
    let other_id = f.host.add_workspace(&other).unwrap().id;
    assert!(f
        .host
        .resolve_git_action(&other_id, &approval.request_id, true)
        .is_err());
    f.host
        .resolve_git_action(&f.id, &approval.request_id, false)
        .unwrap();
    assert!(f
        .host
        .resolve_git_action(&f.id, &approval.request_id, true)
        .is_err());
    assert_eq!(
        f.host.git_status(&f.id).unwrap().changes[0].index_status,
        "?"
    );
    let expired = f.host.prepare_git_action(&f.id, action()).unwrap();
    f.host
        .git_actions
        .get_mut(&expired.request_id)
        .unwrap()
        .expires = Instant::now() - Duration::from_secs(1);
    assert!(f
        .host
        .resolve_git_action(&f.id, &expired.request_id, true)
        .is_err());
    let revoked = f.host.prepare_git_action(&f.id, action()).unwrap();
    f.host.set_plugin_enabled(AGENT_PLUGIN, false).unwrap();
    assert!(f
        .host
        .resolve_git_action(&f.id, &revoked.request_id, true)
        .is_err());
    f.host.set_plugin_enabled(AGENT_PLUGIN, true).unwrap();
    assert_eq!(
        f.host.git_status(&f.id).unwrap().changes[0].index_status,
        "?"
    );
    let db = rusqlite::Connection::open(f.root.path().join("host.sqlite")).unwrap();
    let rows: Vec<(String, String)> = db.prepare("SELECT decision, parameter_digest FROM audit_events WHERE request_id IS NOT NULL ORDER BY id").unwrap().query_map([], |row| Ok((row.get(0)?, row.get(1)?))).unwrap().map(Result::unwrap).collect();
    assert_eq!(
        rows.iter().map(|row| row.0.as_str()).collect::<Vec<_>>(),
        ["pending", "denied", "pending", "failed", "pending", "failed"]
    );
    assert!(rows.iter().all(|row| row.1.len() == 64));
}

#[test]
fn path_escape_repository_metadata_and_options_are_rejected() {
    let mut f = Fixture::new();
    for path in [
        "../outside",
        ".git/config",
        "nested/.GiT/config",
        "/absolute",
        "",
        "dir\\file",
    ] {
        assert!(
            f.host
                .prepare_git_action(
                    &f.id,
                    GitAction::Stage {
                        paths: vec![path.into()]
                    }
                )
                .is_err(),
            "{path}"
        );
    }
    for branch in ["-c", "--help", "bad\0ref"] {
        assert!(f
            .host
            .prepare_git_action(
                &f.id,
                GitAction::Switch {
                    branch: branch.into()
                }
            )
            .is_err());
    }
    assert!(f
        .host
        .prepare_git_action(
            &f.id,
            GitAction::Reset {
                commit: "HEAD".into(),
                hard: true
            }
        )
        .is_err());
    // Literal pathspecs must not interpret a filename as a wildcard.
    std::fs::write(f.repo.join("[x].txt"), "literal").unwrap();
    std::fs::write(f.repo.join("x.txt"), "keep untracked").unwrap();
    f.act(GitAction::Stage {
        paths: vec!["[x].txt".into()],
    })
    .unwrap();
    assert!(f
        .host
        .git_status(&f.id)
        .unwrap()
        .changes
        .iter()
        .any(|c| c.path == "x.txt" && c.index_status == "?"));
    let child = f.repo.join("nested");
    std::fs::create_dir(&child).unwrap();
    let nested = f.host.add_workspace(&child).unwrap().id;
    assert!(f.host.git_status(&nested).is_err());
}

#[test]
fn renames_preserve_both_paths_and_can_be_unstaged() {
    let mut f = Fixture::new();
    f.commit("one\n", "initial");
    git(&f.repo, &["mv", "file.txt", "renamed.txt"]);
    let change = f.host.git_status(&f.id).unwrap().changes.remove(0);
    assert_eq!(change.path, "renamed.txt");
    assert_eq!(change.original_path.as_deref(), Some("file.txt"));
    f.act(GitAction::Unstage {
        paths: vec![change.path, change.original_path.unwrap()],
    })
    .unwrap();
    assert!(git(&f.repo, &["diff", "--cached", "--name-only"]).is_empty());
}

#[test]
fn branches_comparison_history_and_mixed_and_hard_reset() {
    let mut f = Fixture::new();
    let initial = f.commit("one\n", "initial");
    f.act(GitAction::CreateBranch {
        branch: "feature".into(),
    })
    .unwrap();
    let changed = f.commit("two\n", "feature commit");
    assert!(f
        .host
        .git_query(
            &f.id,
            GitQuery::Compare {
                left: "main".into(),
                right: "feature".into()
            }
        )
        .unwrap()
        .contains("+two"));
    assert!(f
        .host
        .git_query(
            &f.id,
            GitQuery::Show {
                commit: changed.clone()
            }
        )
        .unwrap()
        .contains("feature commit"));
    assert!(f
        .host
        .git_query(&f.id, GitQuery::Log)
        .unwrap()
        .contains(&changed));
    assert!(f
        .host
        .git_query(&f.id, GitQuery::Branches)
        .unwrap()
        .contains("feature"));
    f.act(GitAction::Reset {
        commit: initial.clone(),
        hard: false,
    })
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("file.txt")).unwrap(),
        "two\n"
    );
    f.act(GitAction::Reset {
        commit: initial,
        hard: true,
    })
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("file.txt")).unwrap(),
        "one\n"
    );
    f.act(GitAction::Switch {
        branch: "main".into(),
    })
    .unwrap();
}

#[test]
fn stash_restoration_retains_entry_and_changed_reference_invalidates_approval() {
    let mut f = Fixture::new();
    f.commit("base\n", "initial");
    f.write("saved\n");
    f.act(GitAction::StashSave {
        message: "first".into(),
    })
    .unwrap();
    assert!(f.host.git_status(&f.id).unwrap().changes.is_empty());
    assert!(f
        .host
        .git_query(&f.id, GitQuery::Stashes)
        .unwrap()
        .contains("first"));
    let stale = f
        .host
        .prepare_git_action(
            &f.id,
            GitAction::StashDrop {
                reference: "stash@{0}".into(),
            },
        )
        .unwrap();
    f.write("second\n");
    f.act(GitAction::StashSave {
        message: "second".into(),
    })
    .unwrap();
    assert!(f
        .host
        .resolve_git_action(&f.id, &stale.request_id, true)
        .is_err());
    assert_eq!(git(&f.repo, &["stash", "list"]).lines().count(), 2);
    f.act(GitAction::StashApply {
        reference: "stash@{1}".into(),
    })
    .unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("file.txt")).unwrap(),
        "saved\n"
    );
    assert_eq!(git(&f.repo, &["stash", "list"]).lines().count(), 2);
    f.act(GitAction::StashDrop {
        reference: "stash@{1}".into(),
    })
    .unwrap();
    assert_eq!(git(&f.repo, &["stash", "list"]).lines().count(), 1);
}

#[test]
fn merge_conflict_can_be_aborted_or_resolved_and_completed() {
    let mut f = Fixture::new();
    f.commit("base\n", "initial");
    f.act(GitAction::CreateBranch {
        branch: "feature".into(),
    })
    .unwrap();
    f.commit("feature\n", "feature");
    f.act(GitAction::Switch {
        branch: "main".into(),
    })
    .unwrap();
    f.commit("main\n", "main");
    assert!(f
        .act(GitAction::Merge {
            branch: "feature".into()
        })
        .is_err());
    assert_eq!(f.host.git_status(&f.id).unwrap().state, "merge");
    f.act(GitAction::Abort).unwrap();
    assert!(f.host.git_status(&f.id).unwrap().state.is_empty());
    assert!(f
        .act(GitAction::Merge {
            branch: "feature".into()
        })
        .is_err());
    f.act(GitAction::ResolveConflict {
        path: "file.txt".into(),
        theirs: true,
    })
    .unwrap();
    f.act(GitAction::MergeContinue).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("file.txt")).unwrap(),
        "feature\n"
    );
    assert!(f.host.git_status(&f.id).unwrap().state.is_empty());
}

#[test]
fn local_remote_publish_fetch_pull_and_remote_checkout() {
    let mut f = Fixture::new();
    f.commit("base\n", "initial");
    let remote = f.root.path().join("remote.git");
    std::fs::create_dir(&remote).unwrap();
    git(&remote, &["init", "--bare", "-b", "main"]);
    git(
        &f.repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );
    f.act(GitAction::Push {
        remote: Some("origin".into()),
    })
    .unwrap();
    assert!(f
        .host
        .git_query(&f.id, GitQuery::Outgoing)
        .unwrap()
        .is_empty());
    let peer = f.root.path().join("peer");
    git(
        f.root.path(),
        &["clone", remote.to_str().unwrap(), peer.to_str().unwrap()],
    );
    git(&peer, &["config", "user.name", "Peer"]);
    git(&peer, &["config", "user.email", "peer@example.invalid"]);
    std::fs::write(peer.join("file.txt"), "remote\n").unwrap();
    git(&peer, &["commit", "-am", "remote commit"]);
    git(&peer, &["push"]);
    git(&peer, &["switch", "-c", "remote-feature"]);
    git(&peer, &["push", "-u", "origin", "remote-feature"]);
    f.act(GitAction::Fetch).unwrap();
    f.act(GitAction::Pull).unwrap();
    assert_eq!(
        std::fs::read_to_string(f.repo.join("file.txt")).unwrap(),
        "remote\n"
    );
    f.act(GitAction::SwitchRemote {
        branch: "origin/remote-feature".into(),
    })
    .unwrap();
    assert_eq!(
        git(&f.repo, &["branch", "--show-current"]).trim(),
        "remote-feature"
    );
}
