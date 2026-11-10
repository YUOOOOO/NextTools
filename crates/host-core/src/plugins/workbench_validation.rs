use super::{
    anyhow, bail,
    validation::{array_of, is_contrib_id, require_permission},
    PluginManifest, Result, Value,
};

/// Validate workbench pages and services after the plugin's views have been validated.
pub(super) fn validate_workbench_contributions(
    map: &serde_json::Map<String, Value>,
    manifest: &PluginManifest,
) -> Result<()> {
    if let Some(pages) = map.get("workbenchPages") {
        let entries = array_of(pages, "contributes.workbenchPages")?;
        let view_ids: Vec<&str> = map
            .get("views")
            .and_then(Value::as_array)
            .map(|views| {
                views
                    .iter()
                    .filter_map(|view| view.get("id").and_then(Value::as_str))
                    .collect()
            })
            .unwrap_or_default();
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.workbenchPages entry must be an object")
            })?;
            let id = obj
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| is_contrib_id(id))
                .ok_or_else(|| {
                    anyhow!("PLUGIN_INVALID: workbench page id is missing or invalid")
                })?;
            if seen.contains(&id) {
                bail!("PLUGIN_INVALID: duplicate workbench page id {id}");
            }
            seen.push(id);
            if obj
                .get("view")
                .and_then(Value::as_str)
                .filter(|view| view_ids.contains(view))
                .is_none()
            {
                bail!("PLUGIN_INVALID: workbench page {id} must name one of this plugin's views");
            }
        }
    }

    if let Some(services) = map.get("workbenchServices") {
        let entries = array_of(services, "contributes.workbenchServices")?;
        if !entries.is_empty() {
            require_permission(manifest, "ui.view", "workbenchServices")?;
            require_permission(manifest, "agent.tool.register", "workbenchServices")?;
        }
        let mut seen: Vec<&str> = Vec::new();
        for entry in entries {
            let obj = entry.as_object().ok_or_else(|| {
                anyhow!("PLUGIN_INVALID: contributes.workbenchServices entry must be an object")
            })?;
            let name = obj
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| is_contrib_id(name))
                .ok_or_else(|| {
                    anyhow!("PLUGIN_INVALID: workbench service name is missing or invalid")
                })?;
            if seen.contains(&name) {
                bail!("PLUGIN_INVALID: duplicate workbench service {name}");
            }
            seen.push(name);
            let description = obj.get("description").and_then(Value::as_str).unwrap_or("");
            if description.trim().is_empty() {
                bail!("PLUGIN_INVALID: workbench service {name} requires a description");
            }
        }
    }

    Ok(())
}
