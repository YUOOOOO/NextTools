use nexttools_protocol::*;
use ts_rs::TS;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = "packages/protocol/src/generated";
    HostSnapshot::export_all_to(dir)?;
    FileEntry::export_all_to(dir)?;
    FileContent::export_all_to(dir)?;
    CommandEvent::export_all_to(dir)?;
    GitStatus::export_all_to(dir)?;
    Ok(())
}
