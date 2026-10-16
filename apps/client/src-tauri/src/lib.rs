#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod agent;
#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "agent_mobile.rs"]
mod agent;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod agent_mcp;
#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "agent_mcp_mobile.rs"]
mod agent_mcp;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod agent_settings;
#[cfg(any(target_os = "android", target_os = "ios"))]
#[path = "agent_settings_mobile.rs"]
mod agent_settings;
mod remote;
mod remote_crypto;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
use agent_settings::SettingsState;
use host_core::Host;
use nexttools_protocol::*;
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager, State};

struct HostState {
    host: Mutex<Host>,
    shortcuts: Mutex<HashMap<String, (String, Option<String>)>>,
    shortcut_update: Mutex<()>,
}
fn with_host<T>(
    state: &HostState,
    f: impl FnOnce(&mut Host) -> Result<T, host_core::HostError>,
) -> Result<T, String> {
    let mut host = state
        .host
        .lock()
        .map_err(|_| "Host 状态不可用".to_string())?;
    f(&mut host).map_err(|e| e.to_string())
}
#[tauri::command]
fn host_snapshot(state: State<'_, HostState>) -> Result<HostSnapshot, String> {
    let mut snapshot = with_host(&state, |h| h.snapshot())?;
    let statuses = state.shortcuts.lock().map_err(|e| e.to_string())?;
    for binding in &mut snapshot.shortcuts {
        if let Some((status, error)) =
            statuses.get(&format!("{}/{}", binding.plugin_id, binding.command_id))
        {
            binding.status = status.clone();
            binding.error = error.clone();
        }
    }
    Ok(snapshot)
}
#[tauri::command]
fn preferences_update(state: State<'_, HostState>, preferences: Preferences) -> Result<(), String> {
    with_host(&state, |h| h.set_preferences(&preferences))
}
#[tauri::command]
async fn workspace_choose(app: tauri::AppHandle) -> Result<Option<Workspace>, String> {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        let picked = rfd::AsyncFileDialog::new()
            .set_title("选择 NextTools 工作区")
            .pick_folder()
            .await;
        let Some(picked) = picked else {
            return Ok(None);
        };
        with_host(&app.state::<HostState>(), |h| {
            h.add_workspace(picked.path())
        })
        .map(Some)
    }
    #[cfg(any(target_os = "android", target_os = "ios"))]
    {
        let _ = app;
        Err("此平台不允许选择桌面工作区".into())
    }
}
#[tauri::command]
fn files_list(
    state: State<'_, HostState>,
    workspace_id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    with_host(&state, |h| h.list_files(&workspace_id, &path))
}
#[tauri::command]
fn files_read(
    state: State<'_, HostState>,
    workspace_id: String,
    path: String,
) -> Result<FileContent, String> {
    with_host(&state, |h| h.read_file(&workspace_id, &path))
}
#[tauri::command]
fn files_prepare_change(
    state: State<'_, HostState>,
    workspace_id: String,
    change: FileChange,
) -> Result<FileChangeApproval, String> {
    with_host(&state, |h| h.prepare_file_change(&workspace_id, change))
}
#[tauri::command]
fn files_resolve_change(
    state: State<'_, HostState>,
    workspace_id: String,
    request_id: String,
    approved: bool,
) -> Result<(), String> {
    with_host(&state, |h| {
        h.resolve_file_change(&workspace_id, &request_id, approved)
    })
}
#[tauri::command]
async fn git_status(app: tauri::AppHandle, workspace_id: String) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_host(&app.state::<HostState>(), |h| h.git_status(&workspace_id))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_query(
    app: tauri::AppHandle,
    workspace_id: String,
    query: GitQuery,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_host(&app.state::<HostState>(), |h| {
            h.git_query(&workspace_id, query)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_prepare(
    app: tauri::AppHandle,
    workspace_id: String,
    action: GitAction,
) -> Result<GitApproval, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_host(&app.state::<HostState>(), |h| {
            h.prepare_git_action(&workspace_id, action)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn git_resolve(
    app: tauri::AppHandle,
    workspace_id: String,
    request_id: String,
    approved: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_host(&app.state::<HostState>(), |h| {
            h.resolve_git_action(&workspace_id, &request_id, approved)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
fn dispatch(app: &tauri::AppHandle, plugin: &str, command: &str) -> Result<CommandEvent, String> {
    let event = with_host(&app.state::<HostState>(), |h| h.command(plugin, command))?;
    if event.view_id.is_some() {
        if let Some(window) = app.get_webview_window("main") {
            window.show().map_err(|e| e.to_string())?;
            window.set_focus().map_err(|e| e.to_string())?;
        }
    }
    app.emit("host:command", &event)
        .map_err(|e| e.to_string())?;
    Ok(event)
}
#[tauri::command]
fn command_execute(
    app: tauri::AppHandle,
    plugin_id: String,
    command_id: String,
) -> Result<CommandEvent, String> {
    dispatch(&app, &plugin_id, &command_id)
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn register_shortcut(app: &tauri::AppHandle, binding: &ShortcutBinding) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    let plugin = binding.plugin_id.clone();
    let command = binding.command_id.clone();
    let held = Arc::new(AtomicBool::new(false));
    let running = Arc::new(AtomicBool::new(false));
    app.global_shortcut()
        .on_shortcut(binding.accelerator.as_str(), move |app, _, event| {
            if event.state == ShortcutState::Released {
                held.store(false, Ordering::Release);
                return;
            }
            if held.swap(true, Ordering::AcqRel) || running.swap(true, Ordering::AcqRel) {
                return;
            }
            let app = app.clone();
            let plugin = plugin.clone();
            let command = command.clone();
            let running = running.clone();
            tauri::async_runtime::spawn_blocking(move || {
                if let Err(error) = dispatch(&app, &plugin, &command) {
                    let _ = app.emit("host:error", error);
                }
                running.store(false, Ordering::Release);
            });
        })
        .map_err(|e| e.to_string())
}
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn restore_shortcuts(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let snapshot = with_host(&app.state::<HostState>(), |h| h.snapshot())?;
    app.global_shortcut()
        .unregister_all()
        .map_err(|e| e.to_string())?;
    let mut statuses = HashMap::new();
    for binding in snapshot.shortcuts {
        let key = format!("{}/{}", binding.plugin_id, binding.command_id);
        let available = snapshot.plugins.iter().any(|p| {
            p.enabled
                && p.manifest.id == binding.plugin_id
                && p.manifest
                    .contributes
                    .commands
                    .iter()
                    .any(|c| c.id == binding.command_id)
        });
        if !binding.enabled || !available {
            statuses.insert(key, ("unavailable".into(), None));
            continue;
        }
        let result = register_shortcut(app, &binding);
        statuses.insert(
            key,
            match result {
                Ok(()) => ("registered".into(), None),
                Err(e) => ("error".into(), Some(e.to_string())),
            },
        );
    }
    *app.state::<HostState>()
        .shortcuts
        .lock()
        .map_err(|e| e.to_string())? = statuses;
    Ok(())
}
#[cfg(any(target_os = "android", target_os = "ios"))]
fn restore_shortcuts(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}
#[tauri::command]
async fn plugin_set_enabled(
    app: tauri::AppHandle,
    plugin_id: String,
    enabled: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<HostState>();
        let _update = state.shortcut_update.lock().map_err(|e| e.to_string())?;
        with_host(&state, |h| h.set_plugin_enabled(&plugin_id, enabled))?;
        restore_shortcuts(&app)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn shortcut_set(
    app: tauri::AppHandle,
    plugin_id: String,
    command_id: String,
    accelerator: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<HostState>();
        #[cfg(not(any(target_os = "android", target_os = "ios")))]
        {
            use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};
            let _update = state.shortcut_update.lock().map_err(|e| e.to_string())?;
            let value = accelerator
                .filter(|a| !a.trim().is_empty())
                .map(|a| {
                    a.parse::<Shortcut>()
                        .map(|s| s.to_string())
                        .map_err(|e| e.to_string())
                })
                .transpose()?;
            let reserved = "Alt+F4"
                .parse::<Shortcut>()
                .map_err(|e| e.to_string())?
                .to_string();
            if value.as_deref() == Some(reserved.as_str()) {
                return Err("Alt+F4 是宿主保留快捷键（关闭窗口）".into());
            }
            let snapshot = with_host(&state, |h| h.snapshot())?;
            let plugin = snapshot
                .plugins
                .iter()
                .find(|p| {
                    p.manifest.id == plugin_id
                        && p.manifest
                            .contributes
                            .commands
                            .iter()
                            .any(|c| c.id == command_id)
                })
                .ok_or("未知命令")?;
            let old = snapshot
                .shortcuts
                .iter()
                .find(|s| s.plugin_id == plugin_id && s.command_id == command_id);
            if let Some(conflict) = snapshot.shortcuts.iter().find(|s| {
                Some(&s.accelerator) == value.as_ref()
                    && !(s.plugin_id == plugin_id && s.command_id == command_id)
            }) {
                return Err(format!(
                    "快捷键已绑定到 {}/{}",
                    conflict.plugin_id, conflict.command_id
                ));
            }
            let key = format!("{plugin_id}/{command_id}");
            let old_registered = state
                .shortcuts
                .lock()
                .map_err(|e| e.to_string())?
                .get(&key)
                .is_some_and(|(s, _)| s == "registered");
            let same = old.is_some_and(|s| Some(&s.accelerator) == value.as_ref());
            let binding = value.map(|accelerator| ShortcutBinding {
                plugin_id: plugin_id.clone(),
                command_id: command_id.clone(),
                accelerator,
                enabled: true,
                status: "pending".into(),
                error: None,
            });
            let register = plugin.enabled && binding.is_some() && !(same && old_registered);
            if register {
                register_shortcut(&app, binding.as_ref().ok_or("缺少绑定")?)?;
            }
            let persisted = with_host(&state, |h| {
                if let Some(binding) = &binding {
                    h.store.set_shortcut(binding)?;
                } else {
                    h.store.remove_shortcut(&plugin_id, &command_id)?;
                }
                Ok(())
            });
            if let Err(error) = persisted {
                if register {
                    app.global_shortcut()
                        .unregister(binding.as_ref().ok_or("缺少绑定")?.accelerator.as_str())
                        .map_err(|e| format!("{error}；撤回注册失败：{e}"))?;
                }
                return Err(error);
            }
            if old_registered && !same {
                if let Some(old) = old {
                    app.global_shortcut()
                        .unregister(old.accelerator.as_str())
                        .map_err(|e| e.to_string())?;
                }
            }
            let mut statuses = state.shortcuts.lock().map_err(|e| e.to_string())?;
            if binding.is_some() {
                statuses.insert(
                    key,
                    (
                        if plugin.enabled {
                            "registered"
                        } else {
                            "unavailable"
                        }
                        .into(),
                        None,
                    ),
                );
            } else {
                statuses.remove(&key);
            }
            Ok(())
        }
        #[cfg(any(target_os = "android", target_os = "ios"))]
        {
            let _ = (state, plugin_id, command_id, accelerator);
            Err("全局快捷键仅支持桌面端".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init());
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    let builder = builder.plugin(tauri_plugin_global_shortcut::Builder::new().build());
    builder
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let host = Host::open(Path::new(&directory.join("nexttools.sqlite3")))?;
            app.manage(HostState {
                host: Mutex::new(host),
                shortcuts: Mutex::new(HashMap::new()),
                shortcut_update: Mutex::new(()),
            });
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            {
                app.manage(SettingsState::default());
                app.manage(agent_mcp::McpState::default());
                agent_mcp::initialize(app.handle()).map_err(std::io::Error::other)?;
                agent_settings::initialize(app.handle()).map_err(std::io::Error::other)?;
            }
            #[cfg(not(any(target_os = "android", target_os = "ios")))]
            app.manage(agent::AgentState::default());
            remote::initialize(app.handle()).map_err(std::io::Error::other)?;
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        let handle = handle.clone();
                        tauri::async_runtime::spawn(async move {
                            if let Err(error) = remote::remote_action(
                                handle.clone(),
                                "callback".into(),
                                serde_json::json!({"url":url.to_string()}),
                            )
                            .await
                            {
                                let _ = handle.emit("host:error", error);
                            }
                        });
                    }
                });
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = handle.state::<HostState>();
                let Ok(_update) = state.shortcut_update.lock() else {
                    return;
                };
                if let Err(error) = restore_shortcuts(&handle) {
                    let _ = handle.emit("host:error", error);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_snapshot,
            remote::remote_action,
            preferences_update,
            workspace_choose,
            files_list,
            files_read,
            files_prepare_change,
            files_resolve_change,
            git_status,
            git_query,
            git_prepare,
            git_resolve,
            command_execute,
            plugin_set_enabled,
            shortcut_set,
            agent::agent_session_create,
            agent::agent_sessions_list,
            agent::agent_session_resume,
            agent::agent_prompt,
            agent::agent_abort,
            agent::agent_approval_respond,
            agent::agent_session_rename,
            agent::agent_session_thinking,
            agent::agent_session_dispose,
            agent_settings::agent_settings_snapshot,
            agent_settings::agent_configure,
            agent_settings::agent_profile_save,
            agent_settings::agent_profile_select,
            agent_settings::agent_profile_remove,
            agent_settings::agent_skill_import,
            agent_settings::agent_skill_toggle,
            agent_settings::agent_skill_remove,
            agent_mcp::agent_mcp_save,
            agent_mcp::agent_mcp_connect,
            agent_mcp::agent_mcp_disconnect,
            agent_mcp::agent_mcp_remove
        ])
        .run(tauri::generate_context!())
        .expect("NextTools Host 启动失败");
}
