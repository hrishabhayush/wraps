mod bridge;
mod vpn;

use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Manager, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_positioner::{Position, WindowExt};

// Clicking the tray icon blurs the popover first, which hides it; without this
// the click that follows would immediately show it again.
struct LastHide(Mutex<Instant>);

#[tauri::command]
fn quit(app: tauri::AppHandle) {
    app.exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_positioner::init())
        .manage(bridge::Pending::default())
        .manage(vpn::PendingJoin::default())
        .invoke_handler(tauri::generate_handler![quit, bridge::browser_wallet, vpn::vpn_attest, vpn::vpn_connect, vpn::vpn_quote, vpn::vpn_connect_paid, vpn::vpn_cancel, vpn::vpn_disconnect, vpn::open_tx])
        .manage(LastHide(Mutex::new(Instant::now() - Duration::from_secs(1))))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            bridge::start(app.handle().clone());
            // ⌥⌘W toggles the panel, for when the menu bar hides the icon behind the notch.
            app.global_shortcut().on_shortcut("Alt+Super+W", |app, _, e| {
                if e.state() != ShortcutState::Pressed { return }
                let Some(w) = app.get_webview_window("main") else { return };
                if w.is_visible().unwrap_or(false) {
                    let _ = w.hide();
                } else {
                    let _ = w.move_window(Position::TopRight);
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            })?;
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            let tray = TrayIconBuilder::new()
                .icon(tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?)
                .icon_as_template(true)
                .tooltip("Wraps")
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event else { return };
                    let app = tray.app_handle();
                    let Some(w) = app.get_webview_window("main") else { return };
                    let just_hidden = app.state::<LastHide>().0.lock().unwrap().elapsed() < Duration::from_millis(300);
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else if !just_hidden {
                        let _ = w.move_window(Position::TrayCenter);
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                })
                .build(app)?;
            println!("tray rect: {:?}", tray.rect());
            // The menu bar can hide new icons behind the notch, so open the panel once on launch.
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.move_window(Position::TopRight);
                let _ = w.show();
                let _ = w.set_focus();
            }
            Ok(())
        })
        .on_window_event(|w, e| {
            if let WindowEvent::Focused(false) = e {
                *w.app_handle().state::<LastHide>().0.lock().unwrap() = Instant::now();
                let _ = w.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Wraps");
}
