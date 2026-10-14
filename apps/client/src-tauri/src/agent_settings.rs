use nexttools_protocol::{AgentProviderInfo, AgentSettingsSnapshot, AgentSkillConfig};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "agent-settings.json";
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct StoredSkill {
    id: String,
    name: String,
    description: String,
    file_path: String,
    enabled: bool,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct StoredConfig {
    provider: String,
    model: String,
    skills: Vec<StoredSkill>,
}
#[derive(Default)]
pub struct SettingsState {
    config: Mutex<StoredConfig>,
}
fn path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join(FILE_NAME))
}
fn load(app: &AppHandle, state: &SettingsState) -> Result<(), String> {
    let file = path(app)?;
    let Some(parent) = file.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    match fs::read_to_string(file) {
        Ok(text) => {
            *state.config.lock().map_err(|e| e.to_string())? =
                serde_json::from_str::<StoredConfig>(&text).map_err(|e| e.to_string())?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    Ok(())
}
fn save(app: &AppHandle, state: &SettingsState) -> Result<(), String> {
    let file = path(app)?;
    let text = serde_json::to_string_pretty(&*state.config.lock().map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::write(file, text).map_err(|e| e.to_string())
}
pub fn initialize(app: &AppHandle) -> Result<(), String> {
    load(app, &app.state::<SettingsState>())
}
fn credential(provider: &str) -> Result<String, String> {
    if provider.is_empty() {
        return Err("provider is required".into());
    }
    keyring::Entry::new("nexttools.pi-agent", provider)
        .map_err(|e| e.to_string())?
        .get_password()
        .map_err(|e| e.to_string())
}
pub fn configuration(app: &AppHandle) -> Result<(String, String, String), String> {
    let state = app.state::<SettingsState>();
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    if config.provider.is_empty() || config.model.is_empty() {
        return Err("请先配置 Provider 和模型".into());
    }
    Ok((
        config.provider.clone(),
        config.model.clone(),
        credential(&config.provider)?,
    ))
}
pub fn resources(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<SettingsState>();
    let skills = state.config.lock().map_err(|e| e.to_string())?.skills.iter().filter(|s| s.enabled).map(|s| json!({"id":s.id,"name":s.name,"description":s.description,"filePath":s.file_path,"baseDir":Path::new(&s.file_path).parent().and_then(Path::to_str).unwrap_or("")})).collect::<Vec<_>>();
    let mcp = crate::agent_mcp::resources(app)?;
    Ok(json!({"skills": skills, "mcpTools": mcp}))
}
pub fn read_skill(app: &AppHandle, input: &Value) -> Result<Value, String> {
    use std::io::Read;
    let requested = input
        .get("filePath")
        .or_else(|| input.get("path"))
        .and_then(Value::as_str)
        .ok_or("skill_read 缺少 filePath")?;
    let state = app.state::<SettingsState>();
    let config = state.config.lock().map_err(|e| e.to_string())?;
    for skill in config.skills.iter().filter(|skill| skill.enabled) {
        let main = Path::new(&skill.file_path);
        let root = main
            .parent()
            .ok_or("Skill 路径无效")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let requested_path = if requested == skill.id {
            main.to_path_buf()
        } else {
            PathBuf::from(requested)
        };
        let target = if requested_path.is_absolute() {
            requested_path
        } else {
            root.join(requested_path)
        };
        let canonical = match target.canonicalize() {
            Ok(path) => path,
            Err(_) => continue,
        };
        if !canonical.starts_with(&root) || !canonical.is_file() {
            continue;
        }
        let relative = canonical
            .strip_prefix(&root)
            .map_err(|_| "Skill 文件路径越界")?;
        let mut current = root.clone();
        for component in relative.components() {
            current.push(component);
            let metadata = fs::symlink_metadata(&current).map_err(|e| e.to_string())?;
            let mut linked = metadata.file_type().is_symlink();
            #[cfg(target_os = "windows")]
            {
                use std::os::windows::fs::MetadataExt;
                linked |= metadata.file_attributes() & 0x400 != 0;
            }
            if linked {
                return Err("Skill 不能包含符号链接或目录联接".into());
            }
        }
        if fs::symlink_metadata(&target)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Skill 不能读取符号链接".into());
        }
        let mut bytes = Vec::new();
        fs::File::open(&canonical)
            .map_err(|e| e.to_string())?
            .take(1_048_577)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() > 1_048_576 || bytes.contains(&0) {
            return Err("Skill 仅支持 1 MiB 内文本".into());
        }
        let content = String::from_utf8(bytes).map_err(|_| "Skill 不是 UTF-8 文本".to_string())?;
        return Ok(json!({"path":canonical.to_string_lossy(),"content":content}));
    }
    Err("Skill 未启用或路径未授权".into())
}

fn skill_fields(content: &str, fallback: &str) -> (String, String) {
    let content = content.replace("\r\n", "\n");
    let mut name = fallback.to_owned();
    let mut description = String::new();
    if let Some(frontmatter) = content
        .strip_prefix("---\n")
        .and_then(|rest| rest.split_once("\n---").map(|pair| pair.0))
    {
        let mut folded_description = false;
        for line in frontmatter.lines() {
            if folded_description && line.starts_with([' ', '\t']) {
                if !description.is_empty() {
                    description.push(' ');
                }
                description.push_str(line.trim());
                continue;
            }
            folded_description = false;
            if let Some(value) = line.strip_prefix("name:") {
                name = value.trim().trim_matches(['\"', '\'']).to_owned();
            } else if let Some(value) = line.strip_prefix("description:") {
                let value = value.trim();
                folded_description = matches!(value, "|" | ">" | "|-" | ">-");
                if !folded_description {
                    description = value.trim_matches(['\"', '\'']).to_owned();
                }
            }
        }
    }
    (name, description)
}
fn copy_skill_tree(
    source: &Path,
    target: &Path,
    count: &mut usize,
    total: &mut usize,
) -> Result<(), String> {
    for entry in fs::read_dir(source).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        if kind.is_symlink() {
            return Err("Skill 不能包含符号链接".into());
        }
        let path = entry.path();
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            fs::create_dir_all(&destination).map_err(|e| e.to_string())?;
            copy_skill_tree(&path, &destination, count, total)?;
        } else if kind.is_file() {
            let extension = path
                .extension()
                .and_then(|v| v.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !["md", "txt", "json", "yaml", "yml"].contains(&extension.as_str()) {
                continue;
            }
            let bytes = fs::read(&path).map_err(|e| e.to_string())?;
            *count += 1;
            *total += bytes.len();
            if *count > 256
                || *total > 10 * 1_048_576
                || bytes.len() > 1_048_576
                || bytes.contains(&0)
                || std::str::from_utf8(&bytes).is_err()
            {
                return Err("Skill 仅允许最多 256 个、总计 10 MiB 的 UTF-8 文本文件".into());
            }
            fs::write(destination, bytes).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}
#[tauri::command]
pub fn agent_settings_snapshot(app: AppHandle) -> Result<AgentSettingsSnapshot, String> {
    let state = app.state::<SettingsState>();
    let config = state.config.lock().map_err(|e| e.to_string())?.clone();
    let models = crate::agent::model_catalog(&app)?;
    let mut ids = models
        .iter()
        .map(|model| model.provider.clone())
        .collect::<Vec<_>>();
    ids.sort();
    ids.dedup();
    let providers = ids
        .into_iter()
        .map(|id| AgentProviderInfo {
            has_api_key: keyring::Entry::new("nexttools.pi-agent", &id)
                .ok()
                .and_then(|entry| entry.get_password().ok())
                .is_some(),
            id,
        })
        .collect();
    let skills = config
        .skills
        .into_iter()
        .map(|s| AgentSkillConfig {
            id: s.id,
            name: s.name,
            description: s.description,
            enabled: s.enabled,
            file_path: s.file_path,
        })
        .collect();
    let mcp_servers = crate::agent_mcp::snapshot(&app)?;
    Ok(AgentSettingsSnapshot {
        provider: config.provider,
        model: config.model,
        providers,
        models,
        skills,
        mcp_servers,
    })
}
#[tauri::command]
pub fn agent_configure(
    app: AppHandle,
    provider: String,
    model: String,
    api_key: String,
) -> Result<(), String> {
    let provider = provider.trim();
    let model = model.trim();
    if provider.is_empty() || model.is_empty() {
        return Err("provider、model 不能为空".into());
    }
    if !crate::agent::model_catalog(&app)?
        .iter()
        .any(|entry| entry.provider == provider && entry.id == model)
    {
        return Err("所选模型不在 Pi 目录中".into());
    }
    let entry = keyring::Entry::new("nexttools.pi-agent", provider).map_err(|e| e.to_string())?;
    if api_key.trim().is_empty() {
        entry
            .get_password()
            .map_err(|_| "此 Provider 尚未保存 API Key".to_string())?;
    } else {
        entry
            .set_password(api_key.trim())
            .map_err(|e| e.to_string())?;
    }
    let state = app.state::<SettingsState>();
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.provider = provider.into();
    config.model = model.into();
    drop(config);
    save(&app, &state)
}
#[tauri::command]
pub async fn agent_skill_import(app: AppHandle) -> Result<Option<AgentSkillConfig>, String> {
    let Some(source) = rfd::AsyncFileDialog::new()
        .set_title("选择 Skill 文件夹")
        .pick_folder()
        .await
    else {
        return Ok(None);
    };
    let source = source.path();
    let main = source.join("SKILL.md");
    let metadata =
        fs::symlink_metadata(&main).map_err(|_| "所选文件夹缺少 SKILL.md".to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err("SKILL.md 必须是普通文件".into());
    }
    let main_content =
        fs::read_to_string(&main).map_err(|_| "SKILL.md 必须是 UTF-8 文本".to_string())?;
    let fallback = source
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or("skill");
    let (name, description) = skill_fields(&main_content, fallback);
    if name.is_empty()
        || name.len() > 64
        || !name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("Skill name 必须为 1-64 位小写字母、数字或连字符".into());
    }
    if description.is_empty() || description.len() > 1024 {
        return Err("Skill description 必须为 1-1024 字符".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("pi-agent")
        .join("skills")
        .join(&id);
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let mut count = 0;
    let mut total = 0;
    if let Err(error) = copy_skill_tree(source, &root, &mut count, &mut total) {
        let _ = fs::remove_dir_all(&root);
        return Err(error);
    }
    let file_path = root.join("SKILL.md").to_string_lossy().into_owned();
    let stored = StoredSkill {
        id: id.clone(),
        name: name.clone(),
        description: description.clone(),
        file_path: file_path.clone(),
        enabled: true,
    };
    let state = app.state::<SettingsState>();
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    config.skills.push(stored);
    drop(config);
    save(&app, &state)?;
    Ok(Some(AgentSkillConfig {
        id,
        name,
        description,
        enabled: true,
        file_path,
    }))
}
#[tauri::command]
pub fn agent_skill_toggle(app: AppHandle, id: String, enabled: bool) -> Result<(), String> {
    let state = app.state::<SettingsState>();
    let mut config = state.config.lock().map_err(|e| e.to_string())?;
    let skill = config
        .skills
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or("Skill 不存在")?;
    skill.enabled = enabled;
    drop(config);
    save(&app, &state)
}
#[tauri::command]
pub fn agent_skill_remove(app: AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<SettingsState>();
    let root = {
        let mut config = state.config.lock().map_err(|e| e.to_string())?;
        if !config.skills.iter().any(|skill| skill.id == id) {
            return Err("Skill 不存在".into());
        }
        config.skills.retain(|skill| skill.id != id);
        app.path()
            .app_data_dir()
            .map_err(|e| e.to_string())?
            .join("pi-agent")
            .join("skills")
            .join(&id)
    };
    save(&app, &state)?;
    if root.exists() {
        fs::remove_dir_all(root).map_err(|e| e.to_string())?;
    }
    Ok(())
}
