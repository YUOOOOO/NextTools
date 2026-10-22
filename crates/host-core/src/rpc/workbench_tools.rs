use super::{workbench_rpc, AppState};
use crate::tools::{ToolsExecuteParams, ToolsExecuteResult};
use serde_json::{json, Value};

pub fn recognizes(name: &str) -> bool {
    name == "Workbench"
}

pub fn definitions() -> Vec<Value> {
    vec![json!({
        "name": "Workbench",
        "description": "Open, close, switch, or disable a Workbench page. Use this tool instead of Browser. Disable changes status only and keeps the page record. Unknown page ids fail and do not change the saved session.",
        "risk": "low",
        "parameters": {
            "type": "object",
            "additionalProperties": false,
            "required": ["action", "id"],
            "properties": {
                "action": {"type": "string", "enum": ["open", "close", "select", "setStatus"]},
                "id": {"type": "string", "minLength": 1},
                "status": {"type": "string", "enum": ["ready", "unavailable", "disabled"]}
            }
        }
    })]
}

pub fn execute(st: &AppState, params: &ToolsExecuteParams) -> ToolsExecuteResult {
    let started = std::time::Instant::now();
    let result = workbench_rpc::handle(st, "workbench.apply", params.args.clone());
    let (ok, content, error_code) = match result {
        Ok(content) => {
            let ok = content.get("ok").and_then(Value::as_bool).unwrap_or(false);
            (ok, content, (!ok).then_some("UNKNOWN_PAGE".to_string()))
        }
        Err(error) => (
            false,
            json!({"ok": false, "error": error.message}),
            Some("INTERNAL".to_string()),
        ),
    };
    ToolsExecuteResult {
        tool_call_id: params.tool_call_id.clone(),
        ok,
        is_error: (!ok).then_some(true),
        content,
        duration_ms: started.elapsed().as_millis() as u64,
        denied: None,
        error_code,
        command_shell_id: None,
    }
}

#[cfg(test)]
mod tests {
    use super::super::handle_request;
    use crate::sessions;
    use crate::state::AppState;
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::{mpsc, Mutex};

    async fn call(
        state: &Arc<Mutex<AppState>>,
        method: &str,
        params: serde_json::Value,
    ) -> serde_json::Value {
        handle_request(state.clone(), method, params, mpsc::unbounded_channel().0)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn workbench_tool_and_apply_share_the_host_command() {
        let dir = tempfile::tempdir().unwrap();
        let mut st = AppState::open(dir.path()).unwrap();
        st.handshook = true;
        let session =
            sessions::create_session(&st.db, None, Some("agent".into()), None, None, None).unwrap();
        let state = Arc::new(Mutex::new(st));

        let listed = call(&state, "tools.list", json!({})).await;
        assert!(listed["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|tool| tool["name"] == "Workbench"));
        assert!(crate::tools::builtin_tool_defs()
            .as_array()
            .unwrap()
            .iter()
            .all(|tool| tool["name"] != "Workbench"));

        let opened = call(
            &state,
            "workbench.apply",
            json!({"action":"open","id":"example"}),
        )
        .await;
        assert_eq!(opened["ok"], true);
        let disabled = call(
            &state,
            "workbench.apply",
            json!({"action":"setStatus","id":"example","status":"disabled"}),
        )
        .await;
        assert_eq!(
            disabled["session"]["pages"]["example"]["status"],
            "disabled"
        );
        let before = state
            .lock()
            .await
            .db
            .kv_get(crate::workbench::KV_NS, crate::workbench::KV_KEY)
            .unwrap();

        let failed = call(
            &state,
            "tools.execute",
            json!({
                "sessionId": session.id,
                "toolCallId": "workbench-unknown",
                "toolName": "Workbench",
                "args": {"action":"open","id":"foreign"},
                "mode": "agent"
            }),
        )
        .await;
        assert_eq!(failed["ok"], false);
        assert_eq!(failed["content"]["error"], "unknown page");
        let after = state
            .lock()
            .await
            .db
            .kv_get(crate::workbench::KV_NS, crate::workbench::KV_KEY)
            .unwrap();
        assert_eq!(after, before);
        assert_eq!(after.unwrap()["pages"]["example"]["status"], "disabled");
    }
}
