use super::{rpc_err, AppState, JsonRpcError};
use serde_json::Value;

pub(super) fn handle(st: &AppState, method: &str, params: Value) -> Result<Value, JsonRpcError> {
    match method {
        "workbench.get" => {
            if let Some(migrate) = params.get("migrate").filter(|value| !value.is_null()) {
                crate::workbench::import_if_empty(&st.db, migrate)
                    .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))?;
            }
            crate::workbench::load(&st.db)
                .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL"))
        }
        "workbench.apply" => crate::workbench::apply(&st.db, &params)
            .map_err(|error| rpc_err(1000, error.to_string(), "INTERNAL")),
        _ => Err(rpc_err(
            -32601,
            format!("method not found: {method}"),
            "NOT_FOUND",
        )),
    }
}
