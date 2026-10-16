use crate::{
    remote_crypto::{self as crypto, Envelope, Keys},
    with_host, HostState,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use nexttools_protocol::{RemoteDevice, RemotePairing, RemoteSnapshot, RemoteWorkspace};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

#[derive(Clone, Serialize, Deserialize)]
struct Credential {
    keys: Keys,
    refresh: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct Saved {
    server: String,
    device: String,
    email: Option<String>,
    subject: String,
    grants: HashMap<String, RemotePairing>,
    peers: HashMap<String, RemoteDevice>,
    outbox: Vec<Envelope>,
    cursor: String,
    snapshots: Vec<RemoteWorkspace>,
    seen: HashSet<String>,
}
#[derive(Clone)]
struct Login {
    verifier: String,
    state: String,
    nonce: String,
    redirect: String,
    expires: u64,
}
#[derive(Default)]
struct Runtime {
    saved: Saved,
    credential: Option<Credential>,
    access: String,
    expires: u64,
    login: Option<Login>,
    url: Option<String>,
    offer: Option<String>,
    devices: Vec<RemoteDevice>,
    pairings: Vec<RemotePairing>,
    connected: bool,
    error: Option<String>,
    pending: HashMap<String, (u64, Value)>,
    queue: Vec<Envelope>,
}
#[derive(Default)]
pub struct RemoteState {
    inner: Mutex<Runtime>,
    events: Mutex<Vec<(String, Value)>>,
    operation: Mutex<()>,
    stop: Arc<AtomicBool>,
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(err)
}
fn entry(saved: &Saved) -> Result<keyring::Entry, String> {
    keyring::Entry::new(
        "com.nexttools.account",
        &crypto::hash(&format!("{}:{}", saved.server, saved.device)),
    )
    .map_err(err)
}
fn persist(app: &tauri::AppHandle, r: &Runtime) -> Result<(), String> {
    let path = app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("remote-state.json");
    let next = path.with_extension("tmp");
    std::fs::write(&next, serde_json::to_vec(&r.saved).map_err(err)?).map_err(err)?;
    std::fs::rename(&next, &path)
        .or_else(|_| {
            std::fs::copy(&next, &path)?;
            std::fs::remove_file(next)
        })
        .map_err(err)
}
fn api(r: &Runtime, method: &str, path: &str, body: Option<Value>) -> Result<Value, String> {
    if r.access.is_empty() || r.expires <= crypto::now() {
        return Err("账号登录已过期".into());
    }
    let text = body.as_ref().map(Value::to_string).unwrap_or_default();
    let stamp = crypto::now().to_string();
    let proof = ["http.v1", method, path, &stamp, &crypto::hash(&text)].join("\n");
    let sign = r
        .credential
        .as_ref()
        .ok_or("设备凭据不可用")?
        .keys
        .sign(&proof)?;
    let mut req = client()?
        .request(
            method.parse().map_err(err)?,
            format!("{}{path}", r.saved.server),
        )
        .bearer_auth(&r.access)
        .header("x-device-id", &r.saved.device)
        .header("x-device-time", stamp)
        .header("x-device-signature", sign);
    if body.is_some() {
        req = req.header("content-type", "application/json").body(text);
    }
    let response = req.send().map_err(err)?;
    if !response.status().is_success() {
        return Err(format!(
            "服务请求失败 {}：{}",
            response.status(),
            response.text().unwrap_or_default()
        ));
    }
    response.json().map_err(err)
}
fn token(r: &mut Runtime, form: &[(&str, &str)]) -> Result<Value, String> {
    let response = client()?
        .post(format!("{}/oidc/token", r.saved.server))
        .form(form)
        .send()
        .map_err(err)?;
    if !response.status().is_success() {
        return Err(format!("账号认证失败：{}", response.status()));
    }
    let t: Value = response.json().map_err(err)?;
    r.access = t["access_token"]
        .as_str()
        .ok_or("缺少 access token")?
        .into();
    r.expires = crypto::now() + t["expires_in"].as_u64().unwrap_or(0) * 1000;
    Ok(t)
}
fn refresh(r: &mut Runtime) -> Result<(), String> {
    if r.expires > crypto::now() + 45_000 {
        return Ok(());
    }
    let refresh = r.credential.as_ref().ok_or("尚未登录")?.refresh.clone();
    let t = token(
        r,
        &[
            ("grant_type", "refresh_token"),
            ("client_id", "nexttools"),
            ("refresh_token", &refresh),
        ],
    )?;
    let c = r.credential.as_mut().ok_or("缺少凭据")?;
    if let Some(value) = t["refresh_token"].as_str() {
        c.refresh = value.into();
    }
    entry(&r.saved)?
        .set_password(&serde_json::to_string(r.credential.as_ref().unwrap()).map_err(err)?)
        .map_err(err)
}
fn snapshot(r: &Runtime) -> RemoteSnapshot {
    RemoteSnapshot {
        server: r.saved.server.clone(),
        email: r.saved.email.clone(),
        device_id: r.saved.device.clone(),
        connected: r.connected,
        error: r.error.clone(),
        authorization_url: r.url.clone(),
        pairing_code: r.offer.clone(),
        devices: r.devices.clone(),
        pairings: r.pairings.clone(),
        workspaces: r.saved.snapshots.clone(),
    }
}
fn string(v: &Value, key: &str) -> Result<String, String> {
    v[key]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("缺少 {key}"))
}
fn collect(r: &mut Runtime) -> Result<(), String> {
    r.devices = serde_json::from_value(api(r, "GET", "/v1/devices", None)?).map_err(err)?;
    r.pairings = serde_json::from_value(api(r, "GET", "/v1/pairings", None)?).map_err(err)?;
    r.saved.grants.retain(|id, local| {
        let Some(remote) = r.pairings.iter().find(|p| {
            p.id == *id
                && p.status == "approved"
                && p.source == local.source
                && p.target == local.target
        }) else {
            return false;
        };
        local.workspaces.retain(|w| remote.workspaces.contains(w));
        local.operations.retain(|op| remote.operations.contains(op));
        true
    });
    r.saved.snapshots.retain(|w| {
        r.saved.grants.values().any(|p| {
            p.status == "approved"
                && p.target == w.device_id
                && p.workspaces.contains(&w.id)
                && p.operations.iter().any(|v| v == "session.view")
        })
    });
    r.saved.outbox.retain(|e| {
        r.saved.grants.values().any(|p| {
            p.status == "approved"
                && p.source.as_deref() == Some(&e.target)
                && p.workspaces.contains(&e.workspace)
                && p.operations.iter().any(|v| v == "session.view")
        })
    });
    Ok(())
}
fn authorize(r: &Runtime, e: &Envelope) -> Result<RemoteDevice, String> {
    let peer = r.saved.peers.get(&e.source).ok_or("对端公钥尚未确认")?;
    if peer.revoked
        || !r.devices.iter().any(|d| {
            d.id == peer.id
                && !d.revoked
                && d.signing_key == peer.signing_key
                && d.exchange_key == peer.exchange_key
        })
    {
        return Err("设备撤销或公钥变化".into());
    }
    let p = r
        .saved
        .grants
        .values()
        .find(|p| {
            p.status == "approved"
                && p.workspaces.contains(&e.workspace)
                && ((p.target == e.target && p.source.as_deref() == Some(&e.source))
                    || (p.target == e.source && p.source.as_deref() == Some(&e.target)))
        })
        .ok_or("本机未授权项目")?;
    if e.channel == "control"
        && (p.target != r.saved.device
            || !p.operations.contains(&e.operation)
            || !["session.view", "session.prompt", "session.stop"].contains(&e.operation.as_str()))
    {
        return Err("未授权控制操作".into());
    }
    if e.channel != "control" && p.target != e.source {
        return Err("数据必须来自桌面".into());
    }
    if (e.channel == "sync" || (e.channel == "event" && e.operation == "agent.event"))
        && !p.operations.iter().any(|v| v == "session.view")
    {
        return Err("未授权查看会话".into());
    }
    if !matches!(
        (e.channel.as_str(), e.operation.as_str()),
        ("control", _) | ("sync", "snapshot") | ("event", "result" | "agent.event")
    ) {
        return Err("无效消息通道或操作".into());
    }
    Ok(peer.clone())
}
fn receive(app: &tauri::AppHandle, e: Envelope) -> Result<(), String> {
    let state = app.state::<RemoteState>();
    let mut r = state.inner.lock().map_err(err)?;
    collect(&mut r)?;
    let peer = authorize(&r, &e)?;
    let value = e.open(
        &r.credential.as_ref().ok_or("凭据不可用")?.keys,
        &peer.signing_key,
        &peer.exchange_key,
        &r.saved.device,
    )?;
    if !r.saved.seen.insert(e.id.clone()) {
        return if e.channel == "sync" {
            Ok(())
        } else {
            Err("重复控制请求".into())
        };
    }
    persist(app, &r)?;
    if e.channel == "sync" {
        let w: RemoteWorkspace = serde_json::from_value(value).map_err(err)?;
        if w.id != e.workspace || w.device_id != e.source {
            return Err("同步项目不匹配".into());
        }
        r.saved
            .snapshots
            .retain(|v| v.id != w.id || v.device_id != w.device_id);
        r.saved.snapshots.push(w);
        persist(app, &r)?;
    } else if e.channel == "event" {
        if e.operation == "result" {
            let id = string(&value, "requestId")?;
            if r.pending.contains_key(&id) {
                r.pending.insert(id, (crypto::now() + 30_000, value));
            }
        } else if e.operation == "agent.event" {
            let _ = app.emit("remote:event", value);
        }
    } else {
        drop(r);
        #[cfg(not(any(target_os = "ios", target_os = "android")))]
        {
            let result = crate::agent::remote_execute(app, &e.workspace, &e.operation, &value);
            with_host(&app.state::<HostState>(), |h| {
                h.store
                    .audit(
                        Some(&e.workspace),
                        host_core::AGENT_PLUGIN,
                        &format!("remote.{}", e.operation),
                        if result.is_ok() { "allowed" } else { "denied" },
                    )
                    .map_err(Into::into)
            })?;
            let mut r = state.inner.lock().map_err(err)?;
            let response = match result {
                Ok(data) => json!({"requestId":e.id,"data":data}),
                Err(error) => json!({"requestId":e.id,"error":error}),
            };
            let reply = Envelope::seal(
                &r.credential.as_ref().ok_or("凭据不可用")?.keys,
                &r.saved.device,
                &peer.id,
                &peer.exchange_key,
                &e.workspace,
                "event",
                "result",
                &response,
            )?;
            r.queue.push(reply);
        }
        #[cfg(any(target_os = "ios", target_os = "android"))]
        return Err("手机不执行控制命令".into());
    }
    Ok(())
}

pub fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let state = RemoteState::default();
    let path = app
        .path()
        .app_data_dir()
        .map_err(err)?
        .join("remote-state.json");
    if path.exists() {
        let saved: Saved =
            serde_json::from_slice(&std::fs::read(path).map_err(err)?).map_err(err)?;
        let credential = if saved.email.is_some() {
            Some(
                entry(&saved)
                    .and_then(|e| e.get_password().map_err(err))
                    .and_then(|v| serde_json::from_str(&v).map_err(err)),
            )
        } else {
            None
        };
        let mut r = state.inner.lock().map_err(err)?;
        r.saved = saved;
        match credential {
            Some(Ok(c)) => r.credential = Some(c),
            Some(Err(e)) => {
                r.saved.email = None;
                r.error = Some(e);
            }
            None => {}
        }
    }
    app.manage(state);
    let handle = app.clone();
    std::thread::spawn(move || worker(handle));
    Ok(())
}
fn worker(app: tauri::AppHandle) {
    loop {
        let state = app.state::<RemoteState>();
        if state.stop.load(Ordering::Acquire) {
            return;
        }
        let mut identity = None;
        let result = (|| -> Result<(), String> {
            let op = state.operation.lock().map_err(err)?;
            let mut r = state.inner.lock().map_err(err)?;
            if r.credential.is_none() || r.saved.email.is_none() {
                return Ok(());
            }
            identity = Some((r.saved.device.clone(), r.saved.server.clone()));
            refresh(&mut r)?;
            collect(&mut r)?;
            let url = format!("{}/v1/control", r.saved.server)
                .replacen("https:", "wss:", 1)
                .replacen("http:", "ws:", 1);
            let (mut socket, _) = tungstenite::connect(&url).map_err(err)?;
            match socket.get_mut() {
                tungstenite::stream::MaybeTlsStream::Plain(s) => {
                    s.set_read_timeout(Some(Duration::from_millis(200)))
                        .map_err(err)?;
                    s.set_write_timeout(Some(Duration::from_secs(5)))
                        .map_err(err)?;
                }
                tungstenite::stream::MaybeTlsStream::Rustls(s) => {
                    s.sock
                        .set_read_timeout(Some(Duration::from_millis(200)))
                        .map_err(err)?;
                    s.sock
                        .set_write_timeout(Some(Duration::from_secs(5)))
                        .map_err(err)?;
                }
                _ => {}
            }
            let nonce = uuid::Uuid::new_v4().to_string();
            let time = crypto::now();
            let sign = r.credential.as_ref().unwrap().keys.sign(&format!(
                "ws.v1\n{}\n{time}\n{nonce}\n{}",
                r.saved.device,
                crypto::hash(&r.access)
            ))?;
            socket.send(tungstenite::Message::text(json!({"type":"auth","token":r.access,"deviceId":r.saved.device,"time":time,"nonce":nonce,"signature":sign}).to_string())).map_err(err)?;
            let generation = r.saved.device.clone();
            let server = r.saved.server.clone();
            let expires = r.expires;
            drop(r);
            drop(op);
            let mut next_sync = 0;
            loop {
                let r = state.inner.lock().map_err(err)?;
                if r.saved.device != generation
                    || r.saved.server != server
                    || r.saved.email.is_none()
                    || expires <= crypto::now() + 30_000
                {
                    return Ok(());
                }
                drop(r);
                if crypto::now() >= next_sync {
                    sync(&app)?;
                    next_sync = crypto::now() + 10_000;
                }
                drain_events(&app)?;
                let queue = std::mem::take(&mut state.inner.lock().map_err(err)?.queue);
                for e in queue {
                    if e.expires > crypto::now() {
                        socket
                            .send(tungstenite::Message::text(
                                serde_json::to_string(&e).map_err(err)?,
                            ))
                            .map_err(err)?;
                    }
                }
                let message = socket.read();
                let mut r = state.inner.lock().map_err(err)?;
                if r.saved.device != generation
                    || r.saved.server != server
                    || r.saved.email.is_none()
                {
                    return Ok(());
                }
                match message {
                    Ok(tungstenite::Message::Text(text)) => {
                        let v: Value = serde_json::from_str(&text).map_err(err)?;
                        if v["type"] == "ready" {
                            r.connected = true;
                            r.error = None;
                        } else if v["type"] == "error" {
                            r.error = Some("控制请求被拒绝：目标离线、授权失效或消息过期".into());
                        } else {
                            drop(r);
                            receive(&app, serde_json::from_value(v).map_err(err)?)?;
                        }
                    }
                    Ok(tungstenite::Message::Close(_)) => return Err("控制连接已关闭".into()),
                    Err(tungstenite::Error::Io(e))
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) => {}
                    Err(e) => return Err(err(e)),
                    _ => {}
                }
            }
        })();
        if let Ok(mut r) = state.inner.lock() {
            if identity.as_ref().is_some_and(|(device, server)| {
                r.saved.device == *device && r.saved.server == *server && r.saved.email.is_some()
            }) {
                r.connected = false;
                if let Err(e) = result {
                    r.error = Some(e);
                }
                r.queue.clear();
                if let Ok(mut events) = state.events.lock() {
                    events.clear();
                }
            }
        }
        std::thread::sleep(Duration::from_secs(2));
    }
}
fn sync(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<RemoteState>();
    let _op = state.operation.lock().map_err(err)?;
    let mut r = state.inner.lock().map_err(err)?;
    collect(&mut r)?;
    #[cfg(not(any(target_os = "ios", target_os = "android")))]
    {
        let workspaces = with_host(&app.state::<HostState>(), |h| {
            h.store.workspaces().map_err(Into::into)
        })?;
        let grants: Vec<_> = r
            .saved
            .grants
            .values()
            .filter(|p| {
                p.target == r.saved.device
                    && p.status == "approved"
                    && p.operations.iter().any(|v| v == "session.view")
            })
            .cloned()
            .collect();
        for p in grants {
            for w in &workspaces {
                if p.workspaces.contains(&w.id) {
                    let peer = r
                        .saved
                        .peers
                        .get(p.source.as_ref().ok_or("缺少来源")?)
                        .ok_or("对端未确认")?
                        .clone();
                    if !r.devices.iter().any(|d| d.id == peer.id && !d.revoked) {
                        continue;
                    }
                    let data = crate::agent::remote_snapshot(app, &w.id, &w.name, &r.saved.device)?;
                    let e = Envelope::seal(
                        &r.credential.as_ref().ok_or("凭据不可用")?.keys,
                        &r.saved.device,
                        &peer.id,
                        &peer.exchange_key,
                        &w.id,
                        "sync",
                        "snapshot",
                        &serde_json::to_value(data).map_err(err)?,
                    )?;
                    r.saved
                        .outbox
                        .retain(|v| v.target != e.target || v.workspace != e.workspace);
                    r.saved.outbox.push(e);
                }
            }
        }
        persist(app, &r)?;
        while let Some(e) = r.saved.outbox.first().cloned() {
            api(
                &r,
                "POST",
                "/v1/sync",
                Some(serde_json::to_value(e).map_err(err)?),
            )?;
            r.saved.outbox.remove(0);
            persist(app, &r)?;
        }
    }
    let page = api(
        &r,
        "GET",
        &format!(
            "/v1/sync?cursor={}",
            if r.saved.cursor.is_empty() {
                "0"
            } else {
                &r.saved.cursor
            }
        ),
        None,
    )?;
    drop(r);
    for item in page["events"].as_array().ok_or("无效同步响应")? {
        receive(
            app,
            serde_json::from_value(item["envelope"].clone()).map_err(err)?,
        )?;
    }
    let mut r = state.inner.lock().map_err(err)?;
    r.saved.cursor = page["cursor"].as_str().ok_or("无效游标")?.into();
    persist(app, &r)
}

#[tauri::command]
pub async fn remote_action(
    app: tauri::AppHandle,
    action: String,
    input: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || action_sync(&app, &action, input))
        .await
        .map_err(err)?
}
fn action_sync(app: &tauri::AppHandle, action: &str, input: Value) -> Result<Value, String> {
    let state = app.state::<RemoteState>();
    let _op = state.operation.lock().map_err(err)?;
    let mut r = state.inner.lock().map_err(err)?;
    match action {
        "snapshot" => {}
        "login" => {
            let server = string(&input, "server")?.trim_end_matches('/').to_owned();
            let url = reqwest::Url::parse(&server).map_err(err)?;
            if !(url.scheme() == "https"
                || (cfg!(debug_assertions)
                    && url.scheme() == "http"
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))))
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || !url.username().is_empty()
                || url.password().is_some()
            {
                return Err("服务地址必须为 HTTPS 根地址（开发环境仅允许本机 HTTP）".into());
            }
            if r.saved.email.is_some() {
                return Err("请先退出当前账号".into());
            }
            r.saved = Saved {
                server,
                device: uuid::Uuid::new_v4().to_string(),
                ..Saved::default()
            };
            let c = Credential {
                keys: Keys::generate(),
                refresh: String::new(),
            };
            entry(&r.saved)?
                .set_password(&serde_json::to_string(&c).map_err(err)?)
                .map_err(|e| format!("系统凭据库不可用：{e}"))?;
            r.credential = Some(c);
            let redirect = if cfg!(any(target_os = "ios", target_os = "android")) {
                "com.nexttools.mobile:/callback"
            } else {
                "com.nexttools.client:/callback"
            };
            let login = Login {
                verifier: crypto::random(),
                state: crypto::random(),
                nonce: crypto::random(),
                redirect: redirect.into(),
                expires: crypto::now() + 600_000,
            };
            let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(login.verifier.as_bytes()));
            let mut url =
                reqwest::Url::parse(&format!("{}/oidc/auth", r.saved.server)).map_err(err)?;
            url.query_pairs_mut().extend_pairs([
                ("client_id", "nexttools"),
                ("response_type", "code"),
                ("scope", "openid email offline_access"),
                ("redirect_uri", redirect),
                ("state", &login.state),
                ("nonce", &login.nonce),
                ("code_challenge", &challenge),
                ("code_challenge_method", "S256"),
                ("prompt", "consent"),
            ]);
            r.url = Some(url.to_string());
            r.login = Some(login);
            persist(app, &r)?;
            app.opener()
                .open_url(url.to_string(), None::<&str>)
                .map_err(err)?;
        }
        "callback" => {
            let url = reqwest::Url::parse(&string(&input, "url")?).map_err(err)?;
            let login = r.login.take().ok_or("登录请求已失效")?;
            if crypto::now() > login.expires
                || format!("{}:{}", url.scheme(), url.path()) != login.redirect
                || url.host_str().is_some()
            {
                return Err("登录回调地址错误或已过期".into());
            }
            let query: HashMap<_, _> = url.query_pairs().into_owned().collect();
            if query.get("state") != Some(&login.state) {
                return Err("登录 state 校验失败".into());
            }
            let code = query.get("code").ok_or("登录未完成")?;
            let t = token(
                &mut r,
                &[
                    ("grant_type", "authorization_code"),
                    ("client_id", "nexttools"),
                    ("code", code),
                    ("redirect_uri", &login.redirect),
                    ("code_verifier", &login.verifier),
                ],
            )?;
            let jwks: jsonwebtoken::jwk::JwkSet = client()?
                .get(format!("{}/oidc/jwks", r.saved.server))
                .send()
                .map_err(err)?
                .error_for_status()
                .map_err(err)?
                .json()
                .map_err(err)?;
            let id = string(&t, "id_token")?;
            let header = jsonwebtoken::decode_header(&id).map_err(err)?;
            let jwk = jwks
                .find(header.kid.as_deref().ok_or("缺少JWT key id")?)
                .ok_or("未知JWT key")?;
            let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::RS256);
            validation.set_audience(&["nexttools"]);
            validation.set_issuer(&[format!("{}/oidc", r.saved.server)]);
            let claims = jsonwebtoken::decode::<Value>(
                &id,
                &jsonwebtoken::DecodingKey::from_jwk(jwk).map_err(err)?,
                &validation,
            )
            .map_err(err)?
            .claims;
            if claims["nonce"] != login.nonce {
                return Err("登录 nonce 校验失败".into());
            }
            let me = api(&r, "GET", "/v1/me", None)?;
            if claims["sub"] != me["id"] {
                return Err("账号身份不匹配".into());
            }
            r.saved.subject = string(&me, "id")?;
            r.saved.email = Some(string(&me, "email")?);
            r.credential.as_mut().ok_or("缺少凭据")?.refresh = string(&t, "refresh_token")?;
            entry(&r.saved)?
                .set_password(&serde_json::to_string(r.credential.as_ref().unwrap()).map_err(err)?)
                .map_err(err)?;
            let keys = &r.credential.as_ref().unwrap().keys;
            let (sign, exchange) = keys.public()?;
            let name = input["name"].as_str().unwrap_or("NextTools");
            let platform = std::env::consts::OS;
            let proof = [
                "device.v1",
                &r.saved.device,
                name,
                platform,
                &sign,
                &exchange,
            ]
            .join("\n");
            api(
                &r,
                "POST",
                "/v1/devices",
                Some(
                    json!({"id":r.saved.device,"name":name,"platform":platform,"signingKey":sign,"exchangeKey":exchange,"signature":keys.sign(&proof)?}),
                ),
            )?;
            r.url = None;
            r.error = None;
            collect(&mut r)?;
            persist(app, &r)?;
        }
        "logout" => {
            if r.credential.is_some() && r.saved.email.is_some() {
                refresh(&mut r)?;
                api(
                    &r,
                    "POST",
                    &format!("/v1/devices/{}/revoke", r.saved.device),
                    Some(json!({})),
                )?;
            }
            if let Some(c) = &r.credential {
                let _ = client()?
                    .post(format!("{}/oidc/token/revocation", r.saved.server))
                    .form(&[
                        ("client_id", "nexttools"),
                        ("token", &c.refresh),
                        ("token_type_hint", "refresh_token"),
                    ])
                    .send();
            }
            entry(&r.saved)?.delete_credential().map_err(err)?;
            *r = Runtime::default();
            persist(app, &r)?;
        }
        "refresh" => {
            refresh(&mut r)?;
            collect(&mut r)?;
            persist(app, &r)?;
        }
        "offer" => {
            refresh(&mut r)?;
            let v = api(&r, "POST", "/v1/pairings", Some(json!({})))?;
            r.offer = Some(string(&v, "token")?);
        }
        "claim" => {
            refresh(&mut r)?;
            api(
                &r,
                "POST",
                "/v1/pairings/claim",
                Some(json!({"token":string(&input,"token")?})),
            )?;
            collect(&mut r)?;
        }
        "resolve" | "trust" => {
            refresh(&mut r)?;
            collect(&mut r)?;
            let id = string(&input, "id")?;
            let mut p = r
                .pairings
                .iter()
                .find(|p| p.id == id)
                .ok_or("配对不存在")?
                .clone();
            let peer_id = if p.target == r.saved.device {
                p.source.as_ref().ok_or("缺少手机设备")?
            } else {
                &p.target
            };
            let peer = r
                .devices
                .iter()
                .find(|d| d.id == *peer_id && !d.revoked)
                .ok_or("对端不可用")?
                .clone();
            if input["signingKey"] != peer.signing_key || input["exchangeKey"] != peer.exchange_key
            {
                return Err("请重新核对设备指纹".into());
            }
            if action == "resolve" {
                if p.target != r.saved.device {
                    return Err("仅目标桌面确认授权".into());
                }
                let workspaces: Vec<String> =
                    serde_json::from_value(input["workspaces"].clone()).map_err(err)?;
                with_host(&app.state::<HostState>(), |h| {
                    for id in &workspaces {
                        h.authorize_agent(id)?;
                    }
                    Ok(())
                })?;
                let operations: Vec<String> =
                    serde_json::from_value(input["operations"].clone()).map_err(err)?;
                if operations.iter().any(|v| {
                    !["session.view", "session.prompt", "session.stop"].contains(&v.as_str())
                }) {
                    return Err("不允许远程高风险审批".into());
                }
                let approved = input["approved"].as_bool().ok_or("缺少确认决定")?;
                api(
                    &r,
                    "POST",
                    &format!("/v1/pairings/{id}/resolve"),
                    Some(
                        json!({"approved":approved,"workspaces":workspaces,"operations":operations}),
                    ),
                )?;
                p.workspaces = workspaces;
                p.operations = operations;
                p.status = if approved { "approved" } else { "denied" }.into();
            } else if p.status != "approved" {
                return Err("桌面尚未批准配对".into());
            }
            r.saved.peers.insert(peer.id.clone(), peer);
            r.saved.grants.insert(id, p);
            persist(app, &r)?;
            collect(&mut r)?;
        }
        "revoke" => {
            let id = string(&input, "id")?;
            r.saved.grants.remove(&id);
            r.saved.outbox.clear();
            persist(app, &r)?;
            api(
                &r,
                "POST",
                &format!("/v1/pairings/{id}/revoke"),
                Some(json!({})),
            )?;
            collect(&mut r)?;
            persist(app, &r)?;
        }
        "control" => {
            if !r.connected {
                return Err("桌面控制通道未连接；请求不会离线排队".into());
            }
            let target = string(&input, "target")?;
            let workspace = string(&input, "workspace")?;
            let operation = string(&input, "operation")?;
            let p = r
                .saved
                .grants
                .values()
                .find(|p| {
                    p.target == target
                        && p.source.as_deref() == Some(&r.saved.device)
                        && p.workspaces.contains(&workspace)
                        && p.operations.contains(&operation)
                })
                .ok_or("本机未确认配对或操作范围")?;
            if p.status != "approved" {
                return Err("配对已失效".into());
            }
            let peer = r.saved.peers.get(&target).ok_or("请先核对桌面指纹")?;
            let e = Envelope::seal(
                &r.credential.as_ref().ok_or("缺少凭据")?.keys,
                &r.saved.device,
                &target,
                &peer.exchange_key,
                &workspace,
                "control",
                &operation,
                &input["payload"],
            )?;
            let id = e.id.clone();
            r.pending.insert(id.clone(), (e.expires, Value::Null));
            r.queue.push(e);
            return Ok(json!({"requestId":id}));
        }
        "result" => {
            let id = string(&input, "id")?;
            let (deadline, value) = r.pending.get(&id).ok_or("请求不存在")?;
            if value.is_null() {
                if crypto::now() > *deadline {
                    r.pending.remove(&id);
                    return Err("控制请求超时；不会自动重试".into());
                }
                return Ok(Value::Null);
            }
            let value = value.clone();
            r.pending.remove(&id);
            return Ok(value);
        }
        _ => return Err("未知账号操作".into()),
    }
    Ok(serde_json::to_value(snapshot(&r)).map_err(err)?)
}
pub fn forward_event(app: &tauri::AppHandle, workspace: &str, event: &Value) {
    if let Ok(mut events) = app.state::<RemoteState>().events.lock() {
        events.push((workspace.into(), event.clone()));
    }
}
fn drain_events(app: &tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<RemoteState>();
    let events = std::mem::take(&mut *state.events.lock().map_err(err)?);
    let mut r = state.inner.lock().map_err(err)?;
    if !r.connected {
        return Ok(());
    }
    for (workspace, event) in events {
        let peers: Vec<_> = r
            .saved
            .grants
            .values()
            .filter(|p| {
                p.status == "approved"
                    && p.target == r.saved.device
                    && p.workspaces.contains(&workspace)
                    && p.operations.iter().any(|v| v == "session.view")
            })
            .filter_map(|p| p.source.as_ref().and_then(|id| r.saved.peers.get(id)))
            .cloned()
            .collect();
        for peer in peers {
            if let Some(c) = &r.credential {
                let e = Envelope::seal(
                    &c.keys,
                    &r.saved.device,
                    &peer.id,
                    &peer.exchange_key,
                    &workspace,
                    "event",
                    "agent.event",
                    &event,
                )?;
                r.queue.push(e);
            }
        }
    }
    Ok(())
}
