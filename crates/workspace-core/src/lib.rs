use nexttools_protocol::Workspace;
use std::path::{Component, Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("工作区路径必须是存在的目录")]
    InvalidRoot,
    #[error("路径不在已授权工作区内")]
    OutsideRoot,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
pub fn open_workspace(root: &Path) -> Result<Workspace, WorkspaceError> {
    let root = root.canonicalize()?;
    if !root.is_dir() {
        return Err(WorkspaceError::InvalidRoot);
    }
    Ok(Workspace {
        id: uuid::Uuid::new_v4().to_string(),
        name: root
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "工作区".into()),
        root: root.to_string_lossy().into_owned(),
    })
}
pub fn resolve(root: &Path, relative: &str) -> Result<PathBuf, WorkspaceError> {
    let path = Path::new(relative);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err(WorkspaceError::OutsideRoot);
    }
    let root = root.canonicalize()?;
    let target = root.join(path).canonicalize()?;
    if !target.starts_with(&root) {
        return Err(WorkspaceError::OutsideRoot);
    }
    Ok(target)
}
