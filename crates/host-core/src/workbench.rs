use crate::db::Database;
use anyhow::Result;
use serde_json::{json, Map, Value};

pub const KV_NS: &str = "ui";
pub const KV_KEY: &str = "workbenchSession";

const OVERVIEW: &str = "overview";
const EXAMPLE: &str = "example";

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

fn default_session() -> Value {
    json!({
        "pages": { OVERVIEW: page(OVERVIEW, "ready") },
        "openIds": [OVERVIEW],
        "activeId": OVERVIEW,
    })
}

/// Drop unknown pages and keep known records, including `disabled`.
pub fn restore(value: Option<&Value>) -> Value {
    let Some(value) = value.filter(|item| item.is_object()) else {
        return default_session();
    };
    let mut pages = Map::new();
    pages.insert(OVERVIEW.to_string(), page(OVERVIEW, "ready"));
    if let Some(raw_pages) = value.get("pages").and_then(Value::as_object) {
        for (id, raw) in raw_pages {
            let Some(title) = known_title(id) else {
                continue;
            };
            let status = raw
                .get("status")
                .and_then(Value::as_str)
                .filter(|status| is_status(status))
                .unwrap_or("ready");
            pages.insert(
                id.clone(),
                json!({ "id": id, "titleKey": title, "status": status }),
            );
        }
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

pub fn apply_command(session: &Value, command: &Value) -> Result<Value, &'static str> {
    let action = command
        .get("action")
        .and_then(Value::as_str)
        .ok_or("unsupported command")?;
    let id = command
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .ok_or("missing id")?;
    if known_title(id).is_none() {
        return Err("unknown page");
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
                next["pages"][id] = page(id, "ready");
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
    let before = db.kv_get(KV_NS, KV_KEY)?;
    let stored = before.is_some();
    let session = restore(before.as_ref());
    if let Some(raw) = before.as_ref() {
        if raw != &session {
            db.kv_set(KV_NS, KV_KEY, &session)?;
        }
    }
    Ok(json!({ "session": session, "stored": stored }))
}

/// One-shot local migration. An existing host record stays authoritative.
pub fn import_if_empty(db: &Database, migrate: &Value) -> Result<bool> {
    if db.kv_get(KV_NS, KV_KEY)?.is_some() {
        return Ok(false);
    }
    db.kv_set(KV_NS, KV_KEY, &restore(Some(migrate)))?;
    Ok(true)
}

/// Shared by `workbench.apply` and the `Workbench` tool. A rejected command
/// does not write, including when the stored value still contains unknown pages.
pub fn apply(db: &Database, command: &Value) -> Result<Value> {
    let before = db.kv_get(KV_NS, KV_KEY)?;
    let session = restore(before.as_ref());
    match apply_command(&session, command) {
        Err(error) => Ok(json!({ "ok": false, "error": error })),
        Ok(next) => {
            if next != session {
                db.kv_set(KV_NS, KV_KEY, &next)?;
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
}
