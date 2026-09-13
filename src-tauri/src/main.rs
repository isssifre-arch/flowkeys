#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::time::Duration;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// 带重试的抓取：浏览器级 UA/头，5xx 自动重试
async fn fetch_bytes(url: &str, timeout_s: u64) -> Result<Vec<u8>, String> {
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36")
        .timeout(Duration::from_secs(timeout_s))
        .build()
        .map_err(|e| e.to_string())?;
    let mut last = String::from("unknown");
    for attempt in 0..3u32 {
        let r = client
            .get(url)
            .header("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,audio/midi,*/*;q=0.8")
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .send()
            .await;
        match r {
            Ok(resp) => {
                let st = resp.status();
                if st.is_success() {
                    return resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string());
                }
                last = format!("HTTP {}", st);
            }
            Err(e) => last = e.to_string(),
        }
        if attempt < 2 {
            std::thread::sleep(Duration::from_millis(700 * (attempt as u64 + 1)));
        }
    }
    Err(last)
}

/// 桌面端直连抓取（无跨域限制）：返回文本
#[tauri::command]
async fn net_get(url: String) -> Result<String, String> {
    let bytes = fetch_bytes(&url, 25).await?;
    Ok(String::from_utf8_lossy(&bytes).to_string())
}

/// 桌面端直连抓取：返回 base64（用于 MIDI 等二进制）
#[tauri::command]
async fn net_get_b64(url: String) -> Result<String, String> {
    let bytes = fetch_bytes(&url, 60).await?;
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![net_get, net_get_b64])
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            // 托盘：显示主窗口 / 退出
            let show = MenuItemBuilder::with_id("show", "打开主窗口").build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "退出").build(app)?;
            let menu = MenuBuilder::new(app).items(&[&show, &quit]).build()?;
            let icon_path = app
                .path()
                .resource_dir()
                .map(|r| r.join("icons").join("32x32.png"))
                .unwrap_or_else(|_| std::path::PathBuf::from("icons/32x32.png"));
            let mut tray = TrayIconBuilder::with_id("main");
            if icon_path.exists() {
                if let Ok(img) = tauri::image::Image::from_path(&icon_path) {
                    tray = tray.icon(img);
                }
            }
            tray.menu(&menu)
                .tooltip("流光钢琴")
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|win, ev| {
            if let WindowEvent::CloseRequested { api, .. } = ev {
                // 关窗口只隐藏到托盘
                let _ = win.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("tauri run failed");
}
