use nexttools_protocol::PluginManifest;
use thiserror::Error;
#[derive(Debug, Error)]
#[error("插件未启用、未声明能力，或当前工作区策略不允许此操作")]
pub struct Denied;
/// The initialized workspace policy permits only scoped file reads. Writes are
/// denied until the approval/token executor is implemented; never auto-approved.
pub fn authorize(manifest: &PluginManifest, enabled: bool, capability: &str) -> Result<(), Denied> {
    if enabled
        && manifest.capabilities.iter().any(|c| c == capability)
        && capability == "workspace.read"
    {
        Ok(())
    } else {
        Err(Denied)
    }
}
