mod agent_tools;
pub use agent_tools::tool_capability;
use local_store::Store;
use nexttools_protocol::*;
use std::{
    fs,
    io::Read,
    path::{Path, PathBuf},
};
use thiserror::Error;

pub const FILE_PLUGIN: &str = "com.nexttools.workspace-files";
pub const AGENT_PLUGIN: &str = "com.nexttools.pi-agent";
#[derive(Debug, Error)]
pub enum HostError {
    #[error(transparent)]
    Store(#[from] local_store::StoreError),
    #[error(transparent)]
    Workspace(#[from] workspace_core::WorkspaceError),
    #[error(transparent)]
    Permission(#[from] capability_broker::Denied),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
}
pub struct Host {
    pub store: Store,
    manifest: PluginManifest,
    agent_manifest: PluginManifest,
    database: PathBuf,
}
impl Host {
    pub fn open(path: &Path) -> Result<Self, HostError> {
        Ok(Self {
            store: Store::open(path)?,
            manifest: serde_json::from_str(include_str!(
                "../../../plugins/workspace-files/manifest.json"
            ))?,
            agent_manifest: serde_json::from_str(include_str!(
                "../../../plugins/pi-agent/manifest.json"
            ))?,
            database: path.to_path_buf(),
        })
    }
    pub fn snapshot(&self) -> Result<HostSnapshot, HostError> {
        Ok(HostSnapshot {
            protocol_version: PROTOCOL_VERSION,
            platform: std::env::consts::OS.into(),
            database_path: self.database.to_string_lossy().into_owned(),
            workspaces: self.store.workspaces()?,
            plugins: vec![
                PluginInstall {
                    manifest: self.manifest.clone(),
                    enabled: self.store.plugin_enabled(FILE_PLUGIN)?,
                },
                PluginInstall {
                    manifest: self.agent_manifest.clone(),
                    enabled: self.store.plugin_enabled(AGENT_PLUGIN)?,
                },
            ],
            preferences: self.store.preferences()?,
            shortcuts: self.store.shortcuts()?,
        })
    }
    pub fn set_preferences(&self, preferences: &Preferences) -> Result<(), HostError> {
        if !["system", "light", "dark"].contains(&preferences.theme.as_str())
            || !["workbench", "agent"].contains(&preferences.mode.as_str())
            || !["home", "files"].contains(&preferences.workbench_view.as_str())
        {
            return Err(HostError::Invalid("无效的界面设置".into()));
        }
        if let Some(id) = &preferences.active_workspace_id {
            self.workspace(id)?;
        }
        self.store.set_preferences(preferences)?;
        Ok(())
    }
    pub fn add_workspace(&mut self, root: &Path) -> Result<Workspace, HostError> {
        let workspace = self
            .store
            .add_workspace(workspace_core::open_workspace(root)?)?;
        let mut preferences = self.store.preferences()?;
        preferences.active_workspace_id = Some(workspace.id.clone());
        self.store.set_preferences(&preferences)?;
        self.store.audit(
            Some(&workspace.id),
            FILE_PLUGIN,
            "workspace.selected",
            "allowed",
        )?;
        Ok(workspace)
    }
    pub fn workspace(&self, id: &str) -> Result<Workspace, HostError> {
        self.store
            .workspaces()?
            .into_iter()
            .find(|w| w.id == id)
            .ok_or_else(|| HostError::Invalid("请选择已授权工作区".into()))
    }
    pub fn authorize_read(&self, workspace: &str, action: &str) -> Result<Workspace, HostError> {
        let result = capability_broker::authorize(
            &self.manifest,
            self.store.plugin_enabled(FILE_PLUGIN)?,
            "workspace.read",
        );
        if result.is_err() {
            self.store
                .audit(Some(workspace), FILE_PLUGIN, action, "denied")?;
        }
        result?;
        self.workspace(workspace)
    }
    pub fn authorize_write(&self, workspace: &str, action: &str) -> Result<Workspace, HostError> {
        let result = capability_broker::authorize(
            &self.manifest,
            self.store.plugin_enabled(FILE_PLUGIN)?,
            "workspace.write",
        );
        if result.is_err() {
            self.store
                .audit(Some(workspace), FILE_PLUGIN, action, "denied")?;
        }
        result?;
        self.workspace(workspace)
    }
    pub fn write_file(
        &self,
        workspace: &str,
        relative: &str,
        content: &str,
        expected_content: &str,
    ) -> Result<(), HostError> {
        let root = self.authorize_write(workspace, "files.write")?;
        let result = (|| {
            if content.len() > 1_048_576
                || expected_content.len() > 1_048_576
                || content.as_bytes().contains(&0)
            {
                return Err(HostError::Invalid(
                    "仅支持写入 1 MiB 内的 UTF-8 文本文件".into(),
                ));
            }
            let relative_path = Path::new(relative);
            let parent = relative_path
                .parent()
                .and_then(Path::to_str)
                .unwrap_or("");
            let parent_path = workspace_core::resolve(Path::new(&root.root), parent)?;
            let file_name = relative_path
                .file_name()
                .ok_or_else(|| HostError::Invalid("无效文件路径".into()))?;
            let target = parent_path.join(file_name);
            if !target.exists() || !target.is_file() {
                return Err(HostError::Invalid("仅支持写入已存在的普通文件".into()));
            }
            let canonical_root = Path::new(&root.root).canonicalize()?;
            let canonical_target = target.canonicalize()?;
            if !canonical_target.starts_with(&canonical_root) {
                return Err(HostError::Invalid("路径越界".into()));
            }
            let current = fs::read_to_string(&canonical_target)
                .map_err(|_| HostError::Invalid("文件不是 UTF-8 文本".into()))?;
            if current != expected_content {
                return Err(HostError::Invalid("文件已在外部发生变化，请重新加载后再保存".into()));
            }
            fs::write(canonical_target, content)?;
            Ok(())
        })();
        self.store.audit(
            Some(workspace),
            FILE_PLUGIN,
            "files.write",
            if result.is_ok() { "allowed" } else { "failed" },
        )?;
        result
    }
    pub fn list_files(&self, workspace: &str, relative: &str) -> Result<Vec<FileEntry>, HostError> {
        let root = self.authorize_read(workspace, "files.list")?;
        let result = (|| {
            let target = workspace_core::resolve(Path::new(&root.root), relative)?;
            let canonical_root = Path::new(&root.root).canonicalize()?;
            let mut entries = Vec::new();
            for entry in fs::read_dir(target)? {
                let entry = entry?;
                // Do not follow links, junctions or expose their target metadata.
                if entry.file_type()?.is_symlink() {
                    continue;
                }
                let path = entry.path().canonicalize()?;
                if !path.starts_with(&canonical_root) {
                    continue;
                }
                if entries.len() == 5000 {
                    return Err(HostError::Invalid(
                        "目录超过 5000 项，请选择较小的目录".into(),
                    ));
                }
                entries.push(FileEntry {
                    name: entry.file_name().to_string_lossy().into_owned(),
                    path: path
                        .strip_prefix(&canonical_root)
                        .map_err(|_| HostError::Invalid("路径越界".into()))?
                        .to_string_lossy()
                        .replace('\\', "/"),
                    is_directory: path.is_dir(),
                });
            }
            entries.sort_by(|a, b| {
                b.is_directory
                    .cmp(&a.is_directory)
                    .then_with(|| a.name.cmp(&b.name))
            });
            Ok(entries)
        })();
        self.store.audit(
            Some(workspace),
            FILE_PLUGIN,
            "files.list",
            if result.is_ok() { "allowed" } else { "failed" },
        )?;
        result
    }
    pub fn read_file(&self, workspace: &str, relative: &str) -> Result<FileContent, HostError> {
        let root = self.authorize_read(workspace, "files.read")?;
        let result = (|| {
            let path = workspace_core::resolve(Path::new(&root.root), relative)?;
            let file = fs::File::open(path)?;
            if !file.metadata()?.is_file() {
                return Err(HostError::Invalid("不是普通文件".into()));
            }
            let mut bytes = Vec::new();
            file.take(1_048_577).read_to_end(&mut bytes)?;
            if bytes.len() > 1_048_576 || bytes.contains(&0) {
                return Err(HostError::Invalid(
                    "仅支持 1 MiB 内的 UTF-8 文本文件".into(),
                ));
            }
            let content = String::from_utf8(bytes)
                .map_err(|_| HostError::Invalid("文件不是 UTF-8 文本".into()))?;
            Ok(FileContent {
                path: relative.into(),
                content,
            })
        })();
        self.store.audit(
            Some(workspace),
            FILE_PLUGIN,
            "files.read",
            if result.is_ok() { "allowed" } else { "failed" },
        )?;
        result
    }
    pub fn command(&self, plugin: &str, command: &str) -> Result<CommandEvent, HostError> {
        let manifest = match plugin {
            FILE_PLUGIN => &self.manifest,
            AGENT_PLUGIN => &self.agent_manifest,
            _ => return Err(HostError::Invalid("未知插件".into())),
        };
        let cmd = manifest
            .contributes
            .commands
            .iter()
            .find(|c| c.id == command)
            .ok_or_else(|| HostError::Invalid("未知命令".into()))?;
        let workspace = self.store.preferences()?.active_workspace_id;
        let authorized = (|| {
            for cap in &cmd.required_capabilities {
                capability_broker::authorize(manifest, self.store.plugin_enabled(plugin)?, cap)?;
            }
            self.workspace(
                workspace
                    .as_deref()
                    .ok_or_else(|| HostError::Invalid("请先选择工作区".into()))?,
            )?;
            Ok::<(), HostError>(())
        })();
        self.store.audit(
            workspace.as_deref(),
            plugin,
            command,
            if authorized.is_ok() {
                "allowed"
            } else {
                "denied"
            },
        )?;
        authorized?;
        Ok(CommandEvent {
            plugin_id: plugin.into(),
            command_id: command.into(),
            view_id: cmd.view_id.clone(),
        })
    }
    pub fn set_plugin_enabled(&self, plugin: &str, enabled: bool) -> Result<(), HostError> {
        if plugin != FILE_PLUGIN && plugin != AGENT_PLUGIN {
            return Err(HostError::Invalid("未知插件".into()));
        }
        self.store.set_plugin_enabled(plugin, enabled)?;
        Ok(())
    }
}
