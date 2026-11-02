use futures_util::StreamExt;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{ipc::Channel, Emitter, Manager};
use tokio::sync::Mutex;
mod attention;
mod sidecar;
mod transport;
use transport::{Frame, Request, Response, SseParser};
#[derive(Clone, serde::Serialize)]
pub struct Status {
    status: String,
    error: Option<String>,
}
struct Inner {
    status: Status,
    sidecar: Option<sidecar::Sidecar>,
    client: reqwest::Client,
    jar: Arc<reqwest::cookie::Jar>,
    subscriptions: HashMap<String, Subscription>,
    monitor: Option<tokio::task::JoinHandle<()>>,
    attention: attention::Attention,
}
struct Subscription {
    task: tokio::task::JoinHandle<()>,
    channel: Channel<Frame>,
}
impl Subscription {
    fn cancel(self) {
        self.task.abort();
        let _ = self.channel.send(Frame {
            name: "error".into(),
            data: None,
            last_event_id: None,
        });
    }
}
struct AbortTask(tokio::task::JoinHandle<()>);
impl Drop for AbortTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}
struct Host {
    inner: Mutex<Inner>,
    lifecycle: Mutex<()>,
    auth: Mutex<()>,
    quitting: AtomicBool,
    stopped: AtomicBool,
    reachable: AtomicBool,
    visible: AtomicBool,
    generation: AtomicU64,
}
fn set_status(app: &tauri::AppHandle, inner: &mut Inner, status: &str, error: Option<String>) {
    inner.status = Status {
        status: status.into(),
        error,
    };
    let _ = app.emit("desktop:status", &inner.status);
}
fn credential() -> Result<keyring::Entry, String> {
    keyring::Entry::new("com.pi-agent.desktop", "session").map_err(|e| e.to_string())
}
fn client() -> (reqwest::Client, Arc<reqwest::cookie::Jar>) {
    let jar = Arc::new(reqwest::cookie::Jar::default());
    let client = reqwest::Client::builder()
        .no_proxy()
        .cookie_provider(jar.clone())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .build()
        .expect("HTTP client");
    (client, jar)
}
async fn connection(host: &Host) -> Result<(reqwest::Client, String, String, u64), String> {
    for _ in 0..450 {
        let inner = host.inner.lock().await;
        if inner.status.status == "ready" {
            if let Some(s) = &inner.sidecar {
                return Ok((
                    inner.client.clone(),
                    s.url.clone(),
                    s.token.clone(),
                    host.generation.load(Ordering::SeqCst),
                ));
            }
        }
        if inner.status.status != "starting" {
            return Err(inner.status.error.clone().unwrap_or("后端不可用".into()));
        }
        drop(inner);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    Err("等待后端超时".into())
}
#[tauri::command]
async fn backend_status(host: tauri::State<'_, Arc<Host>>) -> Result<Status, String> {
    Ok(host.inner.lock().await.status.clone())
}
#[tauri::command]
async fn backend_request(
    app: tauri::AppHandle,
    host: tauri::State<'_, Arc<Host>>,
    request: Request,
) -> Result<Response, String> {
    let auth_change = ["/api/auth/login", "/api/auth/logout"].contains(&request.path.as_str());
    let _auth = if auth_change {
        Some(host.auth.lock().await)
    } else {
        None
    };
    let (http_client, url, token, generation) = connection(&host).await?;
    if request.method.eq_ignore_ascii_case("POST")
        && transport::is_session_read(&request.path)
        && !native_visible(&app)
    {
        return Ok(Response {
            status: 403,
            body:
                serde_json::json!({"code":"FORBIDDEN","message":"窗口未激活，请在返回应用后重试"})
                    .to_string(),
        });
    }
    let response = transport::forward(&http_client, &url, &token, &request).await?;
    if host.generation.load(Ordering::SeqCst) != generation {
        return Err("后端连接已更新，请重试".into());
    }
    let status = response.status().as_u16();
    if response.headers().contains_key(reqwest::header::SET_COOKIE) {
        use reqwest::cookie::CookieStore;
        let inner = host.inner.lock().await;
        if host.generation.load(Ordering::SeqCst) != generation {
            return Err("后端连接已更新，请重试".into());
        }
        if let Some(cookie) = inner
            .jar
            .cookies(&reqwest::Url::parse(&url).map_err(|_| "无效后端地址")?)
        {
            if let Ok(value) = cookie.to_str() {
                credential()?
                    .set_password(value)
                    .map_err(|_| "无法安全保存登录凭据")?;
            }
        } else {
            let _ = credential()?.delete_credential();
        }
    }
    let body = response.text().await.map_err(|_| "后端响应读取失败")?;
    if host.generation.load(Ordering::SeqCst) != generation {
        return Err("后端连接已更新，请重试".into());
    }
    if status < 300 && ["/api/auth/login", "/api/auth/logout"].contains(&request.path.as_str()) {
        {
            use reqwest::cookie::CookieStore;
            let mut inner = host.inner.lock().await;
            let address = reqwest::Url::parse(&url).map_err(|_| "无效后端地址")?;
            let cookies = inner.jar.cookies(&address);
            let (new_client, new_jar) = client();
            if let Some(cookie) = cookies {
                if let Ok(value) = cookie.to_str() {
                    new_jar.add_cookie_str(value, &address);
                }
            }
            inner.client = new_client;
            inner.jar = new_jar;
            host.generation.fetch_add(1, Ordering::SeqCst);
        }
        reset_monitor(app, host.inner().clone()).await;
    }
    Ok(Response { status, body })
}
#[tauri::command]
async fn backend_subscribe(
    host: tauri::State<'_, Arc<Host>>,
    id: String,
    path: String,
    on_event: Channel<Frame>,
) -> Result<(), String> {
    transport::validate_path(&path)?;
    if id.len() > 256 {
        return Err("订阅标识过长".into());
    }
    let (client, url, token, generation) = connection(&host).await?;
    let mut inner = host.inner.lock().await;
    if host.generation.load(Ordering::SeqCst) != generation {
        return Err("后端连接已更新，请重试".into());
    }
    inner
        .subscriptions
        .retain(|_, subscription| !subscription.task.is_finished());
    if inner.subscriptions.len() >= 128 && !inner.subscriptions.contains_key(&id) {
        return Err("订阅过多".into());
    }
    if let Some(old) = inner.subscriptions.remove(&id) {
        old.cancel();
    }
    let channel = on_event.clone();
    let task = tokio::spawn(async move {
        let result = stream(client, format!("{url}{path}"), token, |frame| {
            channel.send(frame).map_err(|_| "订阅已关闭".into())
        })
        .await;
        if result.is_err() {
            let _ = channel.send(Frame {
                name: "error".into(),
                data: None,
                last_event_id: None,
            });
        }
    });
    inner.subscriptions.insert(
        id,
        Subscription {
            task,
            channel: on_event,
        },
    );
    Ok(())
}
#[tauri::command]
async fn backend_unsubscribe(host: tauri::State<'_, Arc<Host>>, id: String) -> Result<(), String> {
    if let Some(task) = host.inner.lock().await.subscriptions.remove(&id) {
        task.cancel();
    }
    Ok(())
}
async fn stream(
    client: reqwest::Client,
    url: String,
    token: String,
    mut receive: impl FnMut(Frame) -> Result<(), String>,
) -> Result<(), String> {
    let response = client
        .get(url)
        .header("x-pi-desktop-token", token)
        .send()
        .await
        .map_err(|_| "SSE 连接失败")?;
    if !response.status().is_success() {
        return Err("SSE 请求失败".into());
    }
    receive(Frame {
        name: "open".into(),
        data: None,
        last_event_id: None,
    })?;
    let mut parser = SseParser::default();
    let mut bytes = response.bytes_stream();
    while let Some(bytes) = bytes.next().await {
        for frame in parser.push(&bytes.map_err(|_| "SSE 中断")?)? {
            receive(frame)?;
        }
    }
    Err("SSE 已断开".into())
}
#[tauri::command]
async fn backend_restart(
    app: tauri::AppHandle,
    host: tauri::State<'_, Arc<Host>>,
) -> Result<(), String> {
    start(app, host.inner().clone()).await
}
async fn start(app: tauri::AppHandle, host: Arc<Host>) -> Result<(), String> {
    let _serial = host.lifecycle.lock().await;
    if host.quitting.load(Ordering::SeqCst) {
        return Err("应用正在退出".into());
    }
    {
        let mut inner = host.inner.lock().await;
        if inner.status.status == "ready" {
            return Ok(());
        }
        for (_, task) in inner.subscriptions.drain() {
            task.cancel();
        }
        if let Some(task) = inner.monitor.take() {
            task.abort();
        }
        if let Some(mut old) = inner.sidecar.take() {
            old.shutdown().await;
        }
        host.generation.fetch_add(1, Ordering::SeqCst);
        set_status(&app, &mut inner, "starting", None);
    }
    let result = async {
        let data = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        let resources = app.path().resource_dir().map_err(|e| e.to_string())?;
        #[cfg(debug_assertions)]
        let resources = if resources.join("photon_rs_bg.wasm").exists() {
            resources
        } else {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources")
        };
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let filename = if cfg!(windows) {
            "pi-agent-sidecar.exe"
        } else {
            "pi-agent-sidecar"
        };
        let sidecar = exe.parent().ok_or("应用目录不可用")?.join(filename);
        #[cfg(debug_assertions)]
        let sidecar = if sidecar.exists() {
            sidecar
        } else {
            let triple = include_str!(concat!(env!("OUT_DIR"), "/target.txt")).trim();
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("binaries")
                .join(format!(
                    "pi-agent-sidecar-{triple}{}",
                    if cfg!(windows) { ".exe" } else { "" }
                ))
        };
        sidecar::Sidecar::spawn(&sidecar, &data, &resources, &host.quitting).await
    }
    .await;
    let mut inner = host.inner.lock().await;
    match result {
        Ok(mut s) => {
            let (new_client, new_jar) = client();
            inner.client = new_client;
            inner.jar = new_jar;
            if let Ok(entry) = credential() {
                match entry.get_password() {
                    Ok(cookie) => inner.jar.add_cookie_str(
                        &cookie,
                        &reqwest::Url::parse(&s.url).map_err(|_| "无效地址")?,
                    ),
                    Err(keyring::Error::NoEntry) => {}
                    Err(_) => {
                        set_status(&app, &mut inner, "failed", Some("系统凭据库不可用".into()));
                        s.shutdown().await;
                        return Err("系统凭据库不可用".into());
                    }
                }
            }
            inner.sidecar = Some(s);
            set_status(&app, &mut inner, "ready", None);
            drop(inner);
            reset_monitor(app, host.clone()).await;
            Ok(())
        }
        Err(error) => {
            set_status(&app, &mut inner, "failed", Some(error.clone()));
            Err(error)
        }
    }
}
async fn stop(app: tauri::AppHandle, host: Arc<Host>) {
    let _serial = host.lifecycle.lock().await;
    let mut inner = host.inner.lock().await;
    host.generation.fetch_add(1, Ordering::SeqCst);
    set_status(&app, &mut inner, "stopping", None);
    for (_, task) in inner.subscriptions.drain() {
        task.cancel();
    }
    if let Some(task) = inner.monitor.take() {
        task.abort();
    }
    if let Some(mut s) = inner.sidecar.take() {
        s.shutdown().await;
    }
}
fn native_visible(app: &tauri::AppHandle) -> bool {
    app.get_webview_window("main").is_some_and(|window| {
        window.is_visible().unwrap_or(false)
            && !window.is_minimized().unwrap_or(true)
            && window.is_focused().unwrap_or(false)
    })
}
fn publish_visibility(app: &tauri::AppHandle, visible: bool) {
    let state = app.state::<Arc<Host>>();
    if state.visible.swap(visible, Ordering::SeqCst) != visible {
        let _ = app.emit("desktop:visibility", visible);
    }
}
fn update_visibility(app: &tauri::AppHandle) {
    publish_visibility(app, native_visible(app));
}
#[tauri::command]
fn backend_visibility(app: tauri::AppHandle) -> bool {
    let visible = native_visible(&app);
    publish_visibility(&app, visible);
    visible
}
fn show(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    update_visibility(app);
}
fn icon(priority: u8) -> tauri::image::Image<'static> {
    let base = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))
        .expect("bundled Pi icon");
    let mut rgba = base.rgba().to_vec();
    if priority == 2 {
        for pixel in rgba.chunks_exact_mut(4) {
            if pixel[0] < 80 && pixel[1] < 80 {
                pixel.copy_from_slice(&[116, 65, 10, 255]);
            }
        }
    }
    if priority > 0 {
        for y in 20i32..32 {
            for x in 20i32..32 {
                let distance = (x - 26).pow(2) + (y - 26).pow(2);
                let color = if distance <= 16 {
                    Some(if priority == 1 {
                        [34, 197, 94, 255]
                    } else {
                        [251, 191, 36, 255]
                    })
                } else if distance <= 30 {
                    Some([25, 34, 46, 255])
                } else {
                    None
                };
                if let Some(color) = color {
                    let offset = ((y * 32 + x) * 4) as usize;
                    rgba[offset..offset + 4].copy_from_slice(&color);
                }
            }
        }
    }
    tauri::image::Image::new_owned(rgba, 32, 32)
}
#[cfg(target_os = "windows")]
fn overlay_icon(priority: u8) -> tauri::image::Image<'static> {
    let mut rgba = vec![0u8; 16 * 16 * 4];
    for y in 0i32..16 {
        for x in 0i32..16 {
            if (x - 8).pow(2) + (y - 8).pow(2) <= 36 {
                let i = ((y * 16 + x) * 4) as usize;
                rgba[i..i + 4].copy_from_slice(if priority == 1 {
                    &[34, 197, 94, 255]
                } else {
                    &[251, 191, 36, 255]
                });
            }
        }
    }
    tauri::image::Image::new_owned(rgba, 16, 16)
}
fn render_attention(app: &tauri::AppHandle, a: &attention::Attention) {
    use tauri_plugin_notification::NotificationExt;
    let cleared = a
        .notification_ids
        .iter()
        .filter(|(session, _)| a.sessions.get(*session).is_none_or(|n| n.priority() == 0))
        .map(|(_, id)| *id)
        .collect::<Vec<_>>();
    if !cleared.is_empty() {
        let _ = app.notification().remove_active(cleared);
    }
    let p = a.target().map_or(0, |n| n.priority());
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_icon(Some(icon(p)));
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.set_icon(icon(p));
        #[cfg(target_os = "windows")]
        {
            let _ = w.set_overlay_icon(if p == 0 { None } else { Some(overlay_icon(p)) });
        }
        #[cfg(not(target_os = "windows"))]
        {
            let count = a.sessions.values().filter(|n| n.priority() > 0).count() as i64;
            let _ = w.set_badge_count(if count == 0 { None } else { Some(count) });
        }
        #[cfg(target_os = "macos")]
        {
            let _ = w.set_badge_label(match p {
                2 => Some("待处理".into()),
                1 => Some("完成".into()),
                _ => None,
            });
        }
    }
}
async fn reset_monitor(app: tauri::AppHandle, host: Arc<Host>) {
    let mut inner = host.inner.lock().await;
    if let Some(task) = inner.monitor.take() {
        task.abort();
    }
    for (_, subscription) in inner.subscriptions.drain() {
        subscription.cancel();
    }
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().remove_all_active();
    inner.attention.reset();
    render_attention(&app, &inner.attention);
    let cloned = host.clone();
    inner.monitor = Some(tokio::spawn(async move {
        monitor(app, cloned).await;
    }));
}
async fn monitor(app: tauri::AppHandle, host: Arc<Host>) {
    loop {
        if let Ok((client, url, token, _)) = connection(&host).await {
            let snapshot = client
                .get(format!("{url}/api/sessions?limit=100"))
                .header("x-pi-desktop-token", &token)
                .send()
                .await;
            if let Ok(response) = snapshot {
                if response.status().is_success() {
                    if let Ok(value) = response.json::<serde_json::Value>().await {
                        let data = &value["data"];
                        if let Some(sessions) = data["attention"].as_array() {
                            let mut inner = host.inner.lock().await;
                            inner.attention.sessions.clear();
                            for value in sessions {
                                if let Ok(n) =
                                    serde_json::from_value::<attention::Notice>(value.clone())
                                {
                                    if inner.attention.snapshot(n.clone()) {
                                        let id = inner.attention.notification_id(&n.session_id);
                                        notify(&app, &n, id);
                                    }
                                }
                            }
                            render_attention(&app, &inner.attention);
                        }
                        let epoch = data["epoch"].as_str().unwrap_or("");
                        let seq = data["seq"].as_u64().unwrap_or(0);
                        let path = format!("{url}/api/user/events?epoch={epoch}&sinceSeq={seq}");
                        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
                        let task = tokio::spawn(async move {
                            let _ = stream(client, path, token, |frame| {
                                tx.send(frame).map_err(|_| "监视器已关闭".into())
                            })
                            .await;
                        });
                        let _owned_stream = AbortTask(task);
                        while let Some(frame) = rx.recv().await {
                            if frame.name == "resync" {
                                break;
                            }
                            if let Some(data) = frame.data {
                                if let Ok(value) = serde_json::from_str::<serde_json::Value>(&data)
                                {
                                    let mut inner = host.inner.lock().await;
                                    if frame.name == "session_updated" {
                                        if let Ok(n) = serde_json::from_value::<attention::Notice>(
                                            value["data"].clone(),
                                        ) {
                                            if inner.attention.update(n.clone()) {
                                                let id =
                                                    inner.attention.notification_id(&n.session_id);
                                                notify(&app, &n, id);
                                            }
                                        }
                                    } else if frame.name == "session_removed" {
                                        if let Some(id) = value["data"]["sessionId"].as_str() {
                                            inner.attention.remove(id);
                                        }
                                    }
                                    render_attention(&app, &inner.attention);
                                }
                            }
                        }
                    }
                }
            }
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}
fn notify(app: &tauri::AppHandle, n: &attention::Notice, id: i32) {
    use tauri_plugin_notification::NotificationExt;
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }
    let result = app
        .notification()
        .builder()
        .id(id)
        .title(if n.priority() == 2 {
            "Pi Agent · 等待处理"
        } else {
            "Pi Agent · 已完成"
        })
        .body("点击返回对应会话")
        .extra("sessionId", &n.session_id)
        .show();
    if result.is_err() {
        let _ = app.emit(
            "desktop:notification-warning",
            serde_json::json!({"message":"系统通知暂不可用，请通过托盘或应用图标查看待处理消息。"}),
        );
    }
}
pub fn run() {
    let (client, jar) = client();
    let host = Arc::new(Host {
        inner: Mutex::new(Inner {
            status: Status {
                status: "starting".into(),
                error: None,
            },
            sidecar: None,
            client,
            jar,
            subscriptions: HashMap::new(),
            monitor: None,
            attention: attention::Attention::default(),
        }),
        lifecycle: Mutex::new(()),
        auth: Mutex::new(()),
        quitting: AtomicBool::new(false),
        stopped: AtomicBool::new(false),
        reachable: AtomicBool::new(false),
        visible: AtomicBool::new(false),
        generation: AtomicU64::new(0),
    });
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(tauri_plugin_notification::init())
        .manage(host.clone())
        .invoke_handler(tauri::generate_handler![
            backend_request,
            backend_subscribe,
            backend_unsubscribe,
            backend_status,
            backend_restart,
            backend_visibility
        ])
        .setup(move |app| {
            use tauri::{
                menu::{Menu, MenuItem, Submenu},
                tray::TrayIconBuilder,
            };
            let show_item = MenuItem::with_id(app, "show", "显示 Pi Agent", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出应用", true, Some("CmdOrCtrl+Q"))?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let app_menu = Menu::with_items(
                app,
                &[&Submenu::with_items(
                    app,
                    "Pi Agent",
                    true,
                    &[&show_item, &quit_item],
                )?],
            )?;
            app.set_menu(app_menu)?;
            app.on_menu_event(|app, event| {
                if event.id.as_ref() == "quit" {
                    request_quit(app);
                } else if event.id.as_ref() == "show" {
                    navigate(app);
                }
            });
            let built = TrayIconBuilder::with_id("main")
                .icon(icon(0))
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        tauri::tray::TrayIconEvent::Click {
                            button: tauri::tray::MouseButton::Left,
                            button_state: tauri::tray::MouseButtonState::Up,
                            ..
                        }
                    ) {
                        navigate(tray.app_handle());
                    }
                })
                .build(app);
            host.reachable.store(built.is_ok(), Ordering::SeqCst);
            use tauri_plugin_notification::NotificationExt;
            let handle = app.handle().clone();
            app.notification().on_action(move |action| {
                if action.action_id() != "tap" {
                    return;
                }
                let session_id = action
                    .notification()
                    .and_then(|n| n.extra().get("sessionId"))
                    .and_then(|value| value.as_str())
                    .map(str::to_owned);
                navigate_to(&handle, session_id);
            })?;
            let handle = app.handle().clone();
            let state = host.clone();
            tauri::async_runtime::spawn(async move {
                let _ = start(handle, state).await;
            });
            let handle = app.handle().clone();
            let state = host.clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    let mut inner = state.inner.lock().await;
                    if inner.status.status == "ready"
                        && inner.sidecar.as_mut().is_some_and(|s| s.exited())
                    {
                        state.generation.fetch_add(1, Ordering::SeqCst);
                        set_status(
                            &handle,
                            &mut inner,
                            "failed",
                            Some("后端意外退出，请重试".into()),
                        );
                        if let Some(task) = inner.monitor.take() {
                            task.abort();
                        }
                        for (_, task) in inner.subscriptions.drain() {
                            task.cancel();
                        }
                        if let Some(mut sidecar) = inner.sidecar.take() {
                            sidecar.shutdown().await;
                        }
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(
                event,
                tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_)
            ) {
                update_visibility(window.app_handle());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let host = window.state::<Arc<Host>>();
                if !host.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    publish_visibility(window.app_handle(), false);
                    #[cfg(target_os = "macos")]
                    let _ = window.hide();
                    #[cfg(target_os = "windows")]
                    if host.reachable.load(Ordering::SeqCst) {
                        let _ = window.hide();
                    } else {
                        let _ = window.minimize();
                    }
                    // Some Linux desktops create a tray object without showing an indicator.
                    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
                    let _ = window.minimize();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("桌面应用初始化失败")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(&event, tauri::RunEvent::Reopen { .. })
                && !app.state::<Arc<Host>>().quitting.load(Ordering::SeqCst)
            {
                navigate(app);
            }
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                let host = app.state::<Arc<Host>>().inner().clone();
                if !host.stopped.load(Ordering::SeqCst) {
                    api.prevent_exit();
                    request_quit(app);
                }
            }
        });
}
fn request_quit(app: &tauri::AppHandle) {
    let host = app.state::<Arc<Host>>().inner().clone();
    if host.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        stop(handle.clone(), host.clone()).await;
        host.stopped.store(true, Ordering::SeqCst);
        handle.exit(0);
    });
}
fn navigate(app: &tauri::AppHandle) {
    navigate_to(app, None);
}
fn navigate_to(app: &tauri::AppHandle, session_id: Option<String>) {
    let handle = app.clone();
    let host = app.state::<Arc<Host>>().inner().clone();
    tauri::async_runtime::spawn(async move {
        let target = {
            let inner = host.inner.lock().await;
            let notice = match &session_id {
                Some(id) => inner.attention.sessions.get(id),
                None => inner.attention.target(),
            };
            notice.map(|n| serde_json::json!({"workspace":n.workspace,"sessionId":n.session_id}))
        };
        if let Some(target) = target {
            let _ = handle.emit("desktop:navigate", target);
        }
        show(&handle);
    });
}

#[cfg(test)]
mod icon_tests {
    #[test]
    fn completion_keeps_pi_mark_and_adds_small_green_badge() {
        let original = super::icon(0);
        let completed = super::icon(1);
        assert_eq!(
            &original.rgba()[..20 * 32 * 4],
            &completed.rgba()[..20 * 32 * 4]
        );
        let badge = (26 * 32 + 26) * 4;
        assert_eq!(&completed.rgba()[badge..badge + 4], &[34, 197, 94, 255]);
    }
}

#[cfg(test)]
mod proxy_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    #[tokio::test]
    #[ignore]
    async fn localhost_proxy_helper() {
        let url = std::env::var("PI_PROXY_TEST_URL").unwrap();
        let (client, jar) = client();
        jar.add_cookie_str("auth_session=fixture", &reqwest::Url::parse(&url).unwrap());
        let response = transport::forward(
            &client,
            &url,
            "test-owned-token",
            &Request {
                path: "/api/auth/login".into(),
                method: "POST".into(),
                headers: None,
                body: Some(r#"{"username":"test","password":"fixture"}"#.into()),
            },
        )
        .await
        .unwrap();
        assert!(response.status().is_success());
    }
    async fn server(listener: tokio::net::TcpListener) -> bool {
        let Ok(Ok((mut stream, _))) =
            tokio::time::timeout(Duration::from_secs(3), listener.accept()).await
        else {
            return false;
        };
        let mut bytes = Vec::new();
        loop {
            let mut chunk = [0u8; 1024];
            let n = stream.read(&mut chunk).await.unwrap();
            if n == 0 {
                break;
            }
            bytes.extend_from_slice(&chunk[..n]);
            if let Some(end) = bytes.windows(4).position(|b| b == b"\r\n\r\n") {
                let header = String::from_utf8_lossy(&bytes[..end]);
                let size = header
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|n| n.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if bytes.len() >= end + 4 + size {
                    break;
                }
            }
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            .await
            .unwrap();
        true
    }
    #[tokio::test]
    async fn localhost_secrets_never_use_environment_proxy() {
        let origin = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let target = format!("http://{}", origin.local_addr().unwrap());
        let proxy_url = format!("http://{}", proxy.local_addr().unwrap());
        let origin_task = tokio::spawn(server(origin));
        let proxy_task = tokio::spawn(server(proxy));
        let mut command = tokio::process::Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--ignored",
                "--exact",
                "proxy_tests::localhost_proxy_helper",
            ])
            .env("PI_PROXY_TEST_URL", target)
            .env("HTTP_PROXY", &proxy_url)
            .env("http_proxy", &proxy_url)
            .env("HTTPS_PROXY", &proxy_url)
            .env("https_proxy", &proxy_url)
            .env("ALL_PROXY", &proxy_url)
            .env("all_proxy", &proxy_url)
            .env("NO_PROXY", "")
            .env("no_proxy", "")
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().unwrap();
        assert!(tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success());
        let origin_used = origin_task.await.unwrap();
        let proxy_used = proxy_task.await.unwrap();
        assert!(
            origin_used,
            "loopback request failed to reach owned origin directly"
        );
        assert!(!proxy_used, "local credentials reached environment proxy");
    }
}
