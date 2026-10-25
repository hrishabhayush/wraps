// Lets the app use the wallet extension in the user's normal browser (MetaMask, Rabby, Brave…).
// The app stores one pending request, opens http://127.0.0.1:PORT in the browser, the page asks
// the extension to do it and POSTs the result back, which we forward to the UI as an event.
use std::io::Read;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Header, Method, Response, Server};

// Fixed so the wallet remembers this site's permission between launches.
pub const PORT: u16 = 7465;
const PAGE: &str = include_str!("bridge.html");

#[derive(Default)]
pub struct Pending(Mutex<Option<serde_json::Value>>);

pub fn start(app: AppHandle) {
    let server = match Server::http(("127.0.0.1", PORT)) {
        Ok(s) => s,
        Err(e) => return eprintln!("wallet bridge: port {PORT} unavailable: {e}"),
    };
    std::thread::spawn(move || {
        for mut req in server.incoming_requests() {
            // Only answer when addressed as 127.0.0.1 (blocks DNS-rebinding from other sites).
            let host_ok = req.headers().iter().any(|h| h.field.equiv("Host") && h.value.as_str() == format!("127.0.0.1:{PORT}"));
            if !host_ok {
                let _ = req.respond(Response::from_string("forbidden").with_status_code(403));
                continue;
            }
            let json = Header::from_bytes("Content-Type", "application/json").unwrap();
            let res = match (req.method(), req.url()) {
                (Method::Get, "/") => Response::from_string(PAGE)
                    .with_header(Header::from_bytes("Content-Type", "text/html; charset=utf-8").unwrap()),
                (Method::Get, "/request") => {
                    let p = app.state::<Pending>().0.lock().unwrap().clone();
                    Response::from_string(p.unwrap_or(serde_json::Value::Null).to_string()).with_header(json)
                }
                (Method::Post, "/result") => {
                    let mut body = String::new();
                    let _ = req.as_reader().take(64 * 1024).read_to_string(&mut body);
                    match serde_json::from_str::<serde_json::Value>(&body) {
                        // Other sites can POST here but can't read the pending id, so require it to match.
                        Ok(v) => {
                            let state = app.state::<Pending>();
                            let mut pending = state.0.lock().unwrap();
                            if pending.as_ref().map(|p| &p["id"]) == Some(&v["id"]) && !v["id"].is_null() {
                                *pending = None;
                                let _ = app.emit("wallet-result", v);
                                Response::from_string("{\"ok\":true}").with_header(json)
                            } else {
                                Response::from_string("stale request").with_status_code(409)
                            }
                        }
                        Err(_) => Response::from_string("bad json").with_status_code(400),
                    }
                }
                _ => Response::from_string("not found").with_status_code(404),
            };
            let _ = req.respond(res);
        }
    });
}

#[tauri::command]
pub fn browser_wallet(app: AppHandle, request: serde_json::Value) -> Result<(), String> {
    *app.state::<Pending>().0.lock().unwrap() = Some(request);
    // Chrome is where the wallet extension lives; fall back to the default browser if it's missing.
    let url = format!("http://127.0.0.1:{PORT}/");
    let chrome = std::process::Command::new("open").args(["-a", "Google Chrome", &url]).status();
    if !matches!(chrome, Ok(s) if s.success()) {
        std::process::Command::new("open").arg(&url).spawn().map_err(|e| format!("couldn't open the browser: {e}"))?;
    }
    Ok(())
}
