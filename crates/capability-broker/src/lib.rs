use nexttools_protocol::PluginManifest;
use thiserror::Error;
#[derive(Debug, Error)]
#[error("插件未启用、未声明能力，或当前工作区策略不允许此操作")]
pub struct Denied;
/// Read/session operations require an enabled manifest declaration; mutating
/// operations require a separate, single-use desktop approval at execution.
pub fn authorize(manifest: &PluginManifest, enabled: bool, capability: &str) -> Result<(), Denied> {
    if enabled
        && manifest.capabilities.iter().any(|c| c == capability)
        && matches!(capability, "workspace.read" | "agent.session")
    {
        Ok(())
    } else {
        Err(Denied)
    }
}

pub fn authorize_approved(
    manifest: &PluginManifest,
    enabled: bool,
    capability: &str,
    approved: bool,
) -> Result<(), Denied> {
    if authorize(manifest, enabled, capability).is_ok()
        || (enabled
            && approved
            && manifest.capabilities.iter().any(|c| c == capability)
            && matches!(
                capability,
                "workspace.write" | "shell.execute" | "git.commit" | "git.push" | "mcp.invoke"
            ))
    {
        Ok(())
    } else {
        Err(Denied)
    }
}
