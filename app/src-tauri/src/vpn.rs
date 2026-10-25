// One-click VPN: verify the attested relay, pay it with blind tokens, and bring the
// WireGuard tunnel up. Everything ships inside the app: a Node runtime runs the
// bundled join helper, and the bundled wg / wireguard-go binaries run the tunnel.
// macOS asks for the admin password once per connect (routes and utun need root).

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::Value;
use tauri::{AppHandle, Manager};

const RESOURCES: &str = "resources";

fn bin_dir() -> Result<PathBuf, String> {
    // Tauri places externalBin sidecars next to the app executable.
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    exe.parent().map(Path::to_path_buf).ok_or_else(|| "no executable directory".into())
}

fn resource(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let path = app.path().resource_dir().map_err(|e| e.to_string())?.join(RESOURCES).join(name);
    if path.exists() { Ok(path) } else { Err(format!("missing bundled file {name}")) }
}

/// Runs the bundled join helper and returns its one-line JSON result.
fn helper(app: &AppHandle, args: &[&str]) -> Result<Value, String> {
    let node = bin_dir()?.join("node");
    let script = resource(app, "wraps-connect.mjs")?;
    let out = Command::new(node).arg(script).args(args).output().map_err(|e| format!("could not start the connect helper: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let line = err.lines().rev().find(|l| l.contains("Error") || l.contains("failed")).unwrap_or("connect helper failed");
        return Err(line.trim().chars().take(160).collect());
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let last = stdout.lines().last().ok_or("connect helper printed nothing")?;
    serde_json::from_str(last).map_err(|e| format!("bad helper output: {e}"))
}

/// Runs the tunnel script as root through the standard macOS admin prompt.
/// Arguments go through AppleScript's `quoted form of`, never string concatenation.
fn tunnel(app: &AppHandle, args: &[&str]) -> Result<(), String> {
    let script = resource(app, "wraps-tunnel.sh")?;
    let bin = bin_dir()?;
    let mut argv: Vec<String> = vec![script.to_string_lossy().into(), args[0].into(), bin.to_string_lossy().into()];
    argv.extend(args[1..].iter().map(|s| s.to_string()));
    let quoted: Vec<String> = (1..=argv.len()).map(|i| format!("quoted form of item {i} of argv")).collect();
    let body = format!("do shell script {} with administrator privileges", quoted.join(" & \" \" & "));
    let out = Command::new("osascript")
        .args(["-e", "on run argv", "-e", &body, "-e", "end run"])
        .args(&argv)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(if err.contains("-128") { "Admin password prompt was cancelled".into() } else { err.trim().chars().take(160).collect() })
    }
}

#[tauri::command]
pub async fn vpn_attest(app: AppHandle) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || helper(&app, &["--json", "--attest-only"]))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vpn_connect(app: AppHandle, tokens: u32) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tokens = tokens.clamp(1, 20).to_string();
        let joined = helper(&app, &["--json", "--tokens", &tokens])?;
        let profile = joined["profile"].as_str().ok_or("helper returned no profile")?;
        let address = joined["address"].as_str().ok_or("helper returned no address")?;
        let endpoint = joined["endpoint"].as_str().ok_or("helper returned no endpoint")?;
        // `wg setconf` takes only keys, peer and endpoint; the script sets address, routes and DNS.
        let wg_conf: String = profile
            .lines()
            .filter(|l| !l.starts_with("Address") && !l.starts_with("DNS"))
            .map(|l| format!("{l}\n"))
            .collect();
        let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
        let conf = dir.join("wraps-wg.conf");
        let _ = fs::remove_file(&conf);
        let mut f = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&conf).map_err(|e| e.to_string())?;
        f.write_all(wg_conf.as_bytes()).map_err(|e| e.to_string())?;
        drop(f);
        let result = tunnel(&app, &["up", &conf.to_string_lossy(), address, endpoint]);
        let _ = fs::remove_file(&conf); // the private key lives in the running tunnel now, not on disk
        result?;
        Ok(joined.as_object().map(|o| {
            let mut o = o.clone();
            o.remove("profile");
            Value::Object(o)
        }).unwrap_or(Value::Null))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn vpn_disconnect(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || tunnel(&app, &["down"]))
        .await
        .map_err(|e| e.to_string())?
}
