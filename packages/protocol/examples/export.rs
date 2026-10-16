use nexttools_protocol::*;
use ts_rs::TS;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = "packages/protocol/src/generated";
    HostSnapshot::export_all_to(dir)?;
    FileEntry::export_all_to(dir)?;
    FileContent::export_all_to(dir)?;
    FileChangeApproval::export_all_to(dir)?;
    CommandEvent::export_all_to(dir)?;
    GitStatus::export_all_to(dir)?;
    GitQuery::export_all_to(dir)?;
    GitApproval::export_all_to(dir)?;
    AgentSessionInfo::export_all_to(dir)?;
    AgentSessionSummary::export_all_to(dir)?;
    AgentSettingsSnapshot::export_all_to(dir)?;
    McpServerConfig::export_all_to(dir)?;
    Ok(())
}
