use crate::db::Database;
use crate::plugins::PluginManager;
use anyhow::Result;
use serde_json::{json, Map, Value};
use std::path::Path;

pub const KV_NS: &str = "ui";
pub const KV_KEY: &str = "workbenchSession";

const OVERVIEW: &str = "overview";
const EXAMPLE: &str = "example";

/// A plugin `contributes.workbenchPages` entry. The page id is `pluginId/id`.
#[derive(Clone, Debug)]
pub struct PageSource {
    pub id: String,
    pub plugin_id: String,
    pub view_id: String,
    pub title: String,
    pub enabled: bool,
}

fn known_title(id: &str) -> Option<&'static str> {
    match id {
        OVERVIEW => Some("workbench.title"),
        EXAMPLE => Some("workbench.exampleTitle"),
        _ => None,
    }
}

fn is_status(value: &str) -> bool {
    matches!(value, "ready" | "unavailable" | "disabled")
}

fn page(id: &str, status: &str) -> Value {
    json!({
        "id": id,
        "titleKey": known_title(id).unwrap_or("workbench.title"),
        "status": status,
    })
}

fn contributed_page(source: &PageSource, status: &str) -> Value {
    json!({
        "id": source.id,
        "title": source.title,
        "status": status,
        "pluginId": source.plugin_id,
        "viewId": source.view_id,
        "available": source.enabled,
    })
}

fn source_by_id<'a>(sources: &'a [PageSource], id: &str) -> Option<&'a PageSource> {
    sources.iter().find(|source| source.id == id)
}

fn durable(session: &Value) -> Value {
    let mut session = session.clone();
    if let Some(pages) = session
        .get_mut("pages")
        .and_then(|value| value.as_object_mut())
    {
        for page in pages.values_mut() {
            if let Some(object) = page.as_object_mut() {
                object.remove("available");
            }
        }
    }
    session
}

fn default_session() -> Value {
    json!({
        "pages": { OVERVIEW: page(OVERVIEW, "ready") },
        "openIds": [OVERVIEW],
        "activeId": OVERVIEW,
    })
}

fn localized_title(value: &Value, locale: &str) -> Option<String> {
    let text = |value: &str| {
        let trimmed = value.trim();
        (!trimmed.is_empty()).then(|| trimmed.to_string())
    };
    match value {
        Value::String(value) => text(value),
        Value::Object(map) => map
            .get(locale)
            .and_then(Value::as_str)
            .and_then(text)
            .or_else(|| map.get("en").and_then(Value::as_str).and_then(text))
            .or_else(|| map.values().find_map(|value| value.as_str().and_then(text))),
        _ => None,
    }
}

fn view_title(contributes: &Map<String, Value>, view_id: &str, locale: &str) -> Option<String> {
    contributes
        .get("views")
        .and_then(Value::as_array)
        .and_then(|views| {
            views
                .iter()
                .find(|view| view.get("id").and_then(Value::as_str) == Some(view_id))
        })
        .and_then(|view| view.get("title"))
        .and_then(|title| localized_title(title, locale))
}

/// Read enabled and disabled plugin pages. A missing manifest contributes nothing.
pub fn sources_from_plugins(plugins: &PluginManager) -> Vec<PageSource> {
    let mut sources = Vec::new();
    for plugin in &plugins.runtime {
        let Some(path) = plugin.path.as_deref() else {
            continue;
        };
        let Ok(manifest) = PluginManager::read_manifest(Path::new(path)) else {
            continue;
        };
        let Some(contributes) = manifest.contributes.as_ref().and_then(Value::as_object) else {
            continue;
        };
        let Some(pages) = contributes.get("workbenchPages").and_then(Value::as_array) else {
            continue;
        };
        for page in pages {
            let Some(object) = page.as_object() else {
                continue;
            };
            let Some(local_id) = object.get("id").and_then(Value::as_str) else {
                continue;
            };
            let Some(view_id) = object.get("view").and_then(Value::as_str) else {
                continue;
            };
            let id = format!("{}/{local_id}", plugin.id);
            if sources.iter().any(|source: &PageSource| source.id == id) {
                continue;
            }
            sources.push(PageSource {
                id,
                plugin_id: plugin.id.clone(),
                view_id: view_id.to_string(),
                title: view_title(contributes, view_id, &plugins.locale)
                    .unwrap_or_else(|| local_id.to_string()),
                enabled: plugin.enabled,
            });
        }
    }
    sources
}

/// Drop unknown pages and keep known records, including `disabled`.
pub fn restore(value: Option<&Value>, sources: &[PageSource]) -> Value {
    let Some(value) = value.filter(|item| item.is_object()) else {
        return with_sources(default_session(), sources);
    };
    let mut pages = Map::new();
    pages.insert(OVERVIEW.to_string(), page(OVERVIEW, "ready"));
    if let Some(raw_pages) = value.get("pages").and_then(Value::as_object) {
        for (id, raw) in raw_pages {
            let status = raw
                .get("status")
                .and_then(Value::as_str)
                .filter(|status| is_status(status))
                .unwrap_or("ready");
            if let Some(title) = known_title(id) {
                pages.insert(
                    id.clone(),
                    json!({ "id": id, "titleKey": title, "status": status }),
                );
                continue;
            }
            if let Some(source) = source_by_id(sources, id) {
                pages.insert(id.clone(), contributed_page(source, status));
            }
        }
    }
    for source in sources.iter().filter(|source| source.enabled) {
        pages
            .entry(source.id.clone())
            .or_insert_with(|| contributed_page(source, "ready"));
    }
    let open_ids = if let Some(raw_open) = value.get("openIds").and_then(Value::as_array) {
        let mut seen = Vec::new();
        for id in raw_open.iter().filter_map(Value::as_str) {
            if pages.contains_key(id) && !seen.iter().any(|item| item == id) {
                seen.push(id.to_string());
            }
        }
        seen
    } else {
        vec![OVERVIEW.to_string()]
    };
    let active_id = value
        .get("activeId")
        .and_then(Value::as_str)
        .filter(|id| open_ids.iter().any(|open| open == id))
        .map(str::to_string)
        .or_else(|| open_ids.last().cloned());
    json!({
        "pages": pages,
        "openIds": open_ids,
        "activeId": active_id,
    })
}

fn with_sources(session: Value, sources: &[PageSource]) -> Value {
    restore(Some(&session), sources)
}

pub fn apply_command(
    session: &Value,
    command: &Value,
    sources: &[PageSource],
) -> Result<Value, &'static str> {
    let action = command
        .get("action")
        .and_then(Value::as_str)
        .ok_or("unsupported command")?;
    let id = command
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or("missing id")?;
    let source = source_by_id(sources, id);
    if known_title(id).is_none() && source.is_none() {
        return Err("unknown page");
    }
    if action == "open" && source.is_some_and(|source| !source.enabled) {
        return Err("unavailable");
    }
    let mut next = session.clone();
    match action {
        "open" => {
            let mut open_ids = next["openIds"].as_array().cloned().unwrap_or_default();
            if open_ids.iter().any(|item| item.as_str() == Some(id)) {
                next["activeId"] = json!(id);
                return Ok(next);
            }
            if next["pages"].get(id).is_none() {
                next["pages"][id] = match source {
                    Some(source) => contributed_page(source, "ready"),
                    None => page(id, "ready"),
                };
            }
            open_ids.push(json!(id));
            next["openIds"] = json!(open_ids);
            next["activeId"] = json!(id);
            Ok(next)
        }
        "close" => {
            let open_ids: Vec<Value> = next["openIds"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|item| item.as_str() != Some(id))
                .collect();
            if next["activeId"].as_str() == Some(id) {
                next["activeId"] = open_ids.last().cloned().unwrap_or(Value::Null);
            }
            next["openIds"] = json!(open_ids);
            Ok(next)
        }
        "select" => {
            let open = next["openIds"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|item| item.as_str() == Some(id)));
            if !open || next["activeId"].as_str() == Some(id) {
                return Ok(session.clone());
            }
            next["activeId"] = json!(id);
            Ok(next)
        }
        "setStatus" => {
            let status = command
                .get("status")
                .and_then(Value::as_str)
                .filter(|status| is_status(status))
                .ok_or("unsupported command")?;
            let Some(mut existing) = next["pages"].get(id).cloned() else {
                return Ok(session.clone());
            };
            if existing.get("status").and_then(Value::as_str) == Some(status) {
                return Ok(session.clone());
            }
            existing["status"] = json!(status);
            next["pages"][id] = existing;
            Ok(next)
        }
        _ => Err("unsupported command"),
    }
}

fn success(session: &Value) -> Value {
    let active_id = session.get("activeId").cloned().unwrap_or(Value::Null);
    let status = active_id
        .as_str()
        .and_then(|id| session["pages"].get(id))
        .and_then(|page| page.get("status"))
        .cloned();
    json!({
        "ok": true,
        "session": session,
        "activeId": active_id,
        "openIds": session.get("openIds").cloned().unwrap_or(json!([])),
        "status": status,
    })
}

pub fn load(db: &Database) -> Result<Value> {
    load_with(db, &[])
}

pub fn load_with(db: &Database, sources: &[PageSource]) -> Result<Value> {
    let before = db.kv_get(KV_NS, KV_KEY)?;
    let stored = before.is_some();
    let session = restore(before.as_ref(), sources);
    if let Some(raw) = before.as_ref() {
        let persisted = durable(&session);
        if raw != &persisted {
            db.kv_set(KV_NS, KV_KEY, &persisted)?;
        }
    }
    Ok(json!({ "session": session, "stored": stored }))
}

/// One-shot local migration. An existing host record stays authoritative.
pub fn import_if_empty(db: &Database, migrate: &Value) -> Result<bool> {
    import_if_empty_with(db, migrate, &[])
}

pub fn import_if_empty_with(
    db: &Database,
    migrate: &Value,
    sources: &[PageSource],
) -> Result<bool> {
    if db.kv_get(KV_NS, KV_KEY)?.is_some() {
        return Ok(false);
    }
    db.kv_set(KV_NS, KV_KEY, &durable(&restore(Some(migrate), sources)))?;
    Ok(true)
}

/// Shared by `workbench.apply` and the `Workbench` tool. A rejected command
/// does not write, including when the stored value still contains unknown pages.
pub fn apply(db: &Database, command: &Value) -> Result<Value> {
    apply_with(db, command, &[])
}

pub fn apply_with(db: &Database, command: &Value, sources: &[PageSource]) -> Result<Value> {
    let before = db.kv_get(KV_NS, KV_KEY)?;
    let session = restore(before.as_ref(), sources);
    match apply_command(&session, command, sources) {
        Err(error) => Ok(json!({ "ok": false, "error": error })),
        Ok(next) => {
            let persisted = durable(&next);
            if persisted != durable(&session) {
                db.kv_set(KV_NS, KV_KEY, &persisted)?;
            }
            Ok(success(&next))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::SCHEMA_VERSION;

    fn db() -> (tempfile::TempDir, Database) {
        let dir = tempfile::tempdir().unwrap();
        let db = Database::open(&dir.path().join("pi.sqlite")).unwrap();
        (dir, db)
    }

    fn board(enabled: bool) -> PageSource {
        PageSource {
            id: "pi.demo/board".into(),
            plugin_id: "pi.demo".into(),
            view_id: "board".into(),
            title: "Board".into(),
            enabled,
        }
    }

    #[test]
    fn workbench_disable_keeps_the_page_record() {
        let (_dir, db) = db();
        assert_eq!(
            apply(&db, &json!({"action":"open","id":"example"})).unwrap()["ok"],
            true
        );
        let disabled = apply(
            &db,
            &json!({"action":"setStatus","id":"example","status":"disabled"}),
        )
        .unwrap();
        assert_eq!(disabled["ok"], true);
        assert_eq!(
            disabled["session"]["pages"]["example"]["status"],
            "disabled"
        );
        let stored = db.kv_get(KV_NS, KV_KEY).unwrap().unwrap();
        assert_eq!(stored["pages"]["example"]["status"], "disabled");
        assert!(stored["pages"].get("example").is_some());
    }

    #[test]
    fn workbench_unknown_page_is_rejected_and_not_written() {
        let (_dir, db) = db();
        apply(&db, &json!({"action":"open","id":"example"})).unwrap();
        let before = db.kv_get(KV_NS, KV_KEY).unwrap();
        let rejected = apply(&db, &json!({"action":"open","id":"foreign"})).unwrap();
        assert_eq!(rejected, json!({"ok": false, "error": "unknown page"}));
        assert_eq!(db.kv_get(KV_NS, KV_KEY).unwrap(), before);

        let dirty = json!({
            "pages": {
                "example": {"id":"example","titleKey":"workbench.exampleTitle","status":"disabled"},
                "foreign": {"id":"foreign","titleKey":"nope","status":"ready"}
            },
            "openIds": ["foreign", "example"],
            "activeId": "foreign"
        });
        db.kv_set(KV_NS, KV_KEY, &dirty).unwrap();
        let rejected = apply(
            &db,
            &json!({"action":"setStatus","id":"foreign","status":"disabled"}),
        )
        .unwrap();
        assert_eq!(rejected["ok"], false);
        assert_eq!(db.kv_get(KV_NS, KV_KEY).unwrap().as_ref(), Some(&dirty));
    }

    #[test]
    fn workbench_reload_drops_unknown_pages_and_keeps_disabled() {
        let (_dir, db) = db();
        db.kv_set(
            KV_NS,
            KV_KEY,
            &json!({
                "pages": {
                    "example": {"id":"example","titleKey":"workbench.exampleTitle","status":"disabled"},
                    "foreign": {"id":"foreign","titleKey":"nope","status":"ready"}
                },
                "openIds": ["foreign", "example"],
                "activeId": "foreign"
            }),
        )
        .unwrap();
        let loaded = load(&db).unwrap();
        assert_eq!(loaded["stored"], true);
        assert!(loaded["session"]["pages"].get("foreign").is_none());
        assert_eq!(loaded["session"]["pages"]["example"]["status"], "disabled");
        assert_eq!(loaded["session"]["openIds"], json!(["example"]));
        assert_eq!(loaded["session"]["activeId"], "example");
        let stored = db.kv_get(KV_NS, KV_KEY).unwrap().unwrap();
        assert!(stored["pages"].get("foreign").is_none());
        assert_eq!(stored["pages"]["example"]["status"], "disabled");
        let version: i64 = db
            .conn()
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let tables: i64 = db
            .conn()
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name LIKE '%workbench%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(tables, 0);
    }

    #[test]
    fn workbench_import_keeps_the_existing_host_session() {
        let (_dir, db) = db();
        apply(
            &db,
            &json!({"action":"setStatus","id":"overview","status":"disabled"}),
        )
        .unwrap();
        let before = db.kv_get(KV_NS, KV_KEY).unwrap();
        assert_eq!(
            import_if_empty(
                &db,
                &json!({"pages":{"example":{"id":"example","status":"ready"}},"openIds":["example"]})
            )
            .unwrap(),
            false
        );
        assert_eq!(db.kv_get(KV_NS, KV_KEY).unwrap(), before);
        assert_eq!(before.unwrap()["pages"]["overview"]["status"], "disabled");
    }

    #[test]
    fn contributed_page_disable_keeps_the_record_and_a_disabled_plugin_cannot_open() {
        let (_dir, db) = db();
        let sources = [board(true)];
        let opened = apply_with(
            &db,
            &json!({"action":"open","id":"pi.demo/board"}),
            &sources,
        )
        .unwrap();
        assert_eq!(opened["ok"], true);
        assert_eq!(
            opened["session"]["pages"]["pi.demo/board"]["viewId"],
            "board"
        );
        let disabled = apply_with(
            &db,
            &json!({"action":"setStatus","id":"pi.demo/board","status":"disabled"}),
            &sources,
        )
        .unwrap();
        assert_eq!(
            disabled["session"]["pages"]["pi.demo/board"]["status"],
            "disabled"
        );
        assert_eq!(
            disabled["session"]["pages"]["pi.demo/board"]["pluginId"],
            "pi.demo"
        );
        let stored = db.kv_get(KV_NS, KV_KEY).unwrap().unwrap();
        assert!(stored["pages"]["pi.demo/board"].get("available").is_none());
        assert_eq!(stored["pages"]["pi.demo/board"]["status"], "disabled");

        let closed = apply_with(
            &db,
            &json!({"action":"close","id":"pi.demo/board"}),
            &sources,
        )
        .unwrap();
        assert!(closed["session"]["pages"].get("pi.demo/board").is_some());
        assert!(!closed["session"]["openIds"]
            .as_array()
            .unwrap()
            .iter()
            .any(|id| id == "pi.demo/board"));

        let retained = [board(false)];
        let loaded = load_with(&db, &retained).unwrap();
        assert_eq!(
            loaded["session"]["pages"]["pi.demo/board"]["status"],
            "disabled"
        );
        assert_eq!(
            loaded["session"]["pages"]["pi.demo/board"]["available"],
            false
        );
        let before = db.kv_get(KV_NS, KV_KEY).unwrap();
        let rejected = apply_with(
            &db,
            &json!({"action":"open","id":"pi.demo/board"}),
            &retained,
        )
        .unwrap();
        assert_eq!(rejected, json!({"ok": false, "error": "unavailable"}));
        assert_eq!(db.kv_get(KV_NS, KV_KEY).unwrap(), before);
    }
}
