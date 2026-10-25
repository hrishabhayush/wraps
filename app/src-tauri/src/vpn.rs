// One-click VPN: verify the attested relay, pay it with blind tokens, and bring the
// WireGuard tunnel up. Everything ships inside the app: a Node runtime runs the
// bundled join helper, and the bundled wg / wireguard-go binaries run the tunnel.
// macOS asks for the admin password once per connect (routes and utun need root).

use std::fs;
use std::io::Write;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use keyring::Entry;
use rand::rngs::OsRng;
use rand::RngCore;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use zeroize::{Zeroize, Zeroizing};

const RESOURCES: &str = "resources";
const WG_KEYCHAIN_SERVICE: &str = "com.wraps.app.wireguard";
const WG_KEYCHAIN_ACCOUNT: &str = "pending-registration-v1";
static WG_CONNECT_LOCK: Mutex<()> = Mutex::new(());
static WG_KEYCHAIN_LOCK: Mutex<()> = Mutex::new(());

struct PendingRegistration {
    token: String,
    private_key: String,
    connected: bool,
}

impl Drop for PendingRegistration {
    fn drop(&mut self) {
        self.token.zeroize();
        self.private_key.zeroize();
    }
}

fn pending_entry() -> Result<Entry, String> {
    Entry::new(WG_KEYCHAIN_SERVICE, WG_KEYCHAIN_ACCOUNT)
        .map_err(|_| "OS keychain is unavailable for WireGuard registration".to_string())
}

fn load_pending_registration() -> Result<Option<PendingRegistration>, String> {
    let _guard = WG_KEYCHAIN_LOCK.lock().map_err(|_| "WireGuard keychain lock failed")?;
    let entry = pending_entry()?;
    let mut bytes = match entry.get_secret() {
        Ok(bytes) => bytes,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(_) => return Err("could not read pending WireGuard registration from the OS keychain".into()),
    };
    let parsed = serde_json::from_slice::<Value>(&bytes)
        .map_err(|_| "pending WireGuard registration is invalid".to_string());
    bytes.zeroize();
    let mut value = parsed?;
    let extracted = (|| {
        let token = value["token"].as_str().ok_or("pending WireGuard token is invalid")?.to_string();
        let private_key = value["privateKey"].as_str().ok_or("pending WireGuard key is invalid")?.to_string();
        let connected = value["connected"].as_bool().unwrap_or(false);
        Ok::<_, &str>((token, private_key, connected))
    })();
    if let Some(Value::String(secret)) = value.get_mut("token") { secret.zeroize(); }
    if let Some(Value::String(secret)) = value.get_mut("privateKey") { secret.zeroize(); }
    let (mut token, mut private_key, connected) = extracted.map_err(str::to_string)?;
    if !valid_token(&token) || !valid_private_key(&private_key) {
        token.zeroize();
        private_key.zeroize();
        return Err("pending WireGuard registration is invalid".into());
    }
    Ok(Some(PendingRegistration {
        token,
        private_key,
        connected,
    }))
}

fn save_pending_registration(pending: &PendingRegistration) -> Result<(), String> {
    let _guard = WG_KEYCHAIN_LOCK.lock().map_err(|_| "WireGuard keychain lock failed")?;
    let mut value = serde_json::json!({
        "token": pending.token,
        "privateKey": pending.private_key,
        "connected": pending.connected,
    });
    let serialized = serde_json::to_vec(&value);
    if let Some(Value::String(secret)) = value.get_mut("token") { secret.zeroize(); }
    if let Some(Value::String(secret)) = value.get_mut("privateKey") { secret.zeroize(); }
    let mut bytes = serialized.map_err(|_| "could not encode pending WireGuard registration")?;
    let result = pending_entry().and_then(|entry| entry.set_secret(&bytes)
        .map_err(|_| "could not save pending WireGuard registration in the OS keychain".to_string()));
    bytes.zeroize();
    result
}

fn clear_pending_registration() -> Result<(), String> {
    let _guard = WG_KEYCHAIN_LOCK.lock().map_err(|_| "WireGuard keychain lock failed")?;
    match pending_entry()?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("could not clear pending WireGuard registration from the OS keychain".into()),
    }
}

fn valid_token(token: &str) -> bool {
    !token.is_empty() && token.len() <= 8192 && token.bytes().all(|b|
        b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn valid_private_key(key: &str) -> bool {
    key.len() == 44 && key.ends_with('=') && key.bytes().all(|b|
        b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

fn new_wireguard_private_key() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    let encoded = STANDARD.encode(bytes);
    bytes.zeroize();
    encoded
}

fn input_token_disposition(
    has_input: bool,
    reusing_pending: bool,
    input_matches_pending: bool,
    result: &str,
) -> &'static str {
    if !has_input { return "none"; }
    if reusing_pending {
        if !input_matches_pending { return "refund"; }
        return if result == "connected" { "spent" } else { "reserved" };
    }
    match result {
        "connected" => "spent",
        "rejected" => "refund",
        _ => "reserved",
    }
}

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

/// Run a helper with secrets on stdin instead of exposing them in process arguments or logs.
fn helper_with_stdin(app: &AppHandle, resource_name: &str, args: &[&str], input: &[u8]) -> Result<Value, String> {
    let node = bin_dir()?.join("node");
    let script = resource(app, resource_name)?;
    let mut child = Command::new(node)
        .arg(script)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start the connect helper: {e}"))?;
    let mut child_stdin = child.stdin.take().ok_or("connect helper input was unavailable")?;
    if let Err(error) = child_stdin.write_all(input) {
        drop(child_stdin);
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!("could not send the private connect request: {error}"));
    }
    drop(child_stdin);
    let output = child.wait_with_output().map_err(|e| format!("connect helper failed: {e}"))?;
    let mut stdout = output.stdout;
    if !output.status.success() {
        let error = String::from_utf8_lossy(&output.stderr);
        let line = error.lines().rev().find(|line| line.contains("Error") || line.contains("failed"))
            .unwrap_or("connect helper failed");
        stdout.zeroize();
        return Err(line.trim().chars().take(160).collect());
    }
    let parsed = (|| {
        let text = String::from_utf8_lossy(&stdout);
        let last = text.lines().last().ok_or("connect helper printed nothing")?;
        serde_json::from_str(last).map_err(|e| format!("bad connect helper output: {e}"))
    })();
    stdout.zeroize();
    parsed
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
pub async fn vpn_connect(app: AppHandle, token: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _connect_guard = WG_CONNECT_LOCK.lock().map_err(|_| "WireGuard connect lock failed")?;
        if token.as_deref().is_some_and(|value| !valid_token(value)) {
            return Err("the stored blind token is invalid".into());
        }

        let mut pending = load_pending_registration()?;
        let mut reused_pending = pending.is_some();
        if pending.as_ref().is_some_and(|p| p.connected)
            && token.as_deref() != pending.as_ref().map(|p| p.token.as_str())
        {
            // The previous registration completed, while the app wallet has advanced to a new token.
            clear_pending_registration()?;
            pending = None;
            reused_pending = false;
        }
        if pending.is_none() {
            let Some(token_value) = token.as_ref() else {
                return Ok(serde_json::json!({ "status": "no-token", "inputTokenDisposition": "none" }));
            };
            let mut created = PendingRegistration {
                token: token_value.clone(),
                private_key: new_wireguard_private_key(),
                connected: false,
            };
            if let Err(error) = save_pending_registration(&created) {
                created.token.zeroize();
                created.private_key.zeroize();
                return Err(error);
            }
            pending = Some(created);
        }
        let pending = pending.as_ref().expect("pending registration was created");
        let input_matches_pending = token.as_deref() == Some(pending.token.as_str());
        let mut payload = serde_json::json!({
            "token": pending.token,
            "privateKey": pending.private_key,
        });
        let encoded = serde_json::to_vec(&payload);
        if let Some(Value::String(secret)) = payload.get_mut("token") { secret.zeroize(); }
        if let Some(Value::String(secret)) = payload.get_mut("privateKey") { secret.zeroize(); }
        let mut input = encoded.map_err(|_| "could not encode the private WireGuard registration")?;
        let helper_result = helper_with_stdin(&app, "wraps-connect.mjs", &["--json"], &input);
        input.zeroize();
        let joined = match helper_result {
            Ok(value) => value,
            Err(error) => serde_json::json!({ "status": "unknown", "error": error }),
        };
        let helper_status = joined["status"].as_str().unwrap_or("unknown");
        if helper_status == "rejected" {
            if !reused_pending { clear_pending_registration()?; }
            let status = if reused_pending { "pending" } else { "rejected" };
            return Ok(serde_json::json!({
                "status": status,
                "inputTokenDisposition": input_token_disposition(token.is_some(), reused_pending, input_matches_pending, status),
                "error": joined["error"].as_str().unwrap_or("WireGuard registration was rejected"),
            }));
        }
        if helper_status != "registered" {
            return Ok(serde_json::json!({
                "status": "pending",
                "inputTokenDisposition": input_token_disposition(token.is_some(), reused_pending, input_matches_pending, "pending"),
                "error": joined["error"].as_str().unwrap_or("registration outcome is unknown; retry Connect to resolve the same token"),
            }));
        }

        let tunnel_result = start_tunnel_from_profile(&app, joined);
        if let Err(error) = tunnel_result {
            return Ok(serde_json::json!({
                "status": "pending",
                "inputTokenDisposition": input_token_disposition(token.is_some(), reused_pending, input_matches_pending, "pending"),
                "error": format!("quota registration succeeded but the tunnel did not start: {error}"),
            }));
        }
        let mut connected = PendingRegistration {
            token: pending.token.clone(),
            private_key: pending.private_key.clone(),
            connected: true,
        };
        if let Err(error) = save_pending_registration(&connected) {
            let _ = tunnel(&app, &["down"]);
            connected.token.zeroize();
            connected.private_key.zeroize();
            return Ok(serde_json::json!({
                "status": "pending",
                "inputTokenDisposition": input_token_disposition(token.is_some(), reused_pending, input_matches_pending, "pending"),
                "error": format!("registration succeeded but its retry state could not be saved: {error}"),
            }));
        }
        connected.token.zeroize();
        connected.private_key.zeroize();
        Ok(serde_json::json!({
            "status": "connected",
            "inputTokenDisposition": input_token_disposition(token.is_some(), reused_pending, input_matches_pending, "connected"),
            "tokens": 1,
            "megabytes": 10,
        }))
    })
    .await
    .map_err(|e| e.to_string())?
}

fn start_tunnel_from_profile(app: &AppHandle, mut joined: Value) -> Result<(), String> {
    let profile = Zeroizing::new(joined["profile"].as_str().ok_or("helper returned no WireGuard profile")?.to_string());
    let address = joined["address"].as_str().ok_or("helper returned no tunnel address")?.to_string();
    let endpoint = joined["endpoint"].as_str().ok_or("helper returned no relay endpoint")?.to_string();
    if let Some(Value::String(value)) = joined.get_mut("profile") { value.zeroize(); }
    joined.as_object_mut().map(|object| object.remove("profile"));

    // `wg setconf` takes keys, peer and endpoint; the script sets address, routes and DNS.
    let wg_conf = Zeroizing::new(profile.lines()
        .filter(|line| !line.starts_with("Address") && !line.starts_with("DNS"))
        .map(|line| format!("{line}\n"))
        .collect::<String>());
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let conf = dir.join("wraps-wg.conf");
    let _ = fs::remove_file(&conf);
    let mut file = fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&conf)
        .map_err(|e| e.to_string())?;
    file.write_all(wg_conf.as_bytes()).map_err(|e| e.to_string())?;
    drop(file);
    let result = tunnel(app, &["up", &conf.to_string_lossy(), &address, &endpoint]);
    let _ = fs::remove_file(&conf); // the private key lives in the running tunnel now, not on disk
    result
}

#[tauri::command]
pub async fn vpn_finalize_connect() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _connect_guard = WG_CONNECT_LOCK.lock().map_err(|_| "WireGuard connect lock failed")?;
        let pending = load_pending_registration()?;
        match pending {
            None => Ok(()),
            Some(pending) if pending.connected => clear_pending_registration(),
            Some(_) => Err("WireGuard registration is still unresolved".into()),
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definite_first_attempt_rejection_refunds_the_app_token() {
        assert_eq!(input_token_disposition(true, false, false, "rejected"), "refund");
    }

    #[test]
    fn unknown_first_attempt_keeps_the_token_reserved_for_retry() {
        assert_eq!(input_token_disposition(true, false, false, "pending"), "reserved");
    }

    #[test]
    fn retries_keep_the_same_token_and_refund_a_new_unused_token() {
        assert_eq!(input_token_disposition(true, true, true, "pending"), "reserved");
        assert_eq!(input_token_disposition(true, true, true, "connected"), "spent");
        assert_eq!(input_token_disposition(true, true, false, "pending"), "refund");
    }

    #[test]
    fn connect_without_a_wallet_token_does_not_mint_a_replacement() {
        assert_eq!(input_token_disposition(false, false, false, "no-token"), "none");
    }
}
