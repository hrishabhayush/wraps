// One-click VPN: verify the attested relay, pay it with blind tokens, and bring the
// WireGuard tunnel up. Everything ships inside the app: a Node runtime runs the
// bundled join helper, and the bundled wg / wireguard-go binaries run the tunnel.
// macOS asks for the admin password once per connect (routes and utun need root).

use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};
use std::sync::Mutex;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

/// A helper started by `topup_quote`, waiting for the user's wallet to pay its RLUSD quote.
#[derive(Default)]
pub struct PendingJoin(Mutex<Option<(Child, BufReader<ChildStdout>)>>);

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

/// Runs the bundled join helper and returns its one-line JSON result. `input` goes to its stdin.
/// A failure that the helper describes as JSON (`{"error", "unspent"}`) comes back as that JSON text.
fn helper(app: &AppHandle, args: &[&str], input: Option<&str>) -> Result<Value, String> {
    let node = bin_dir()?.join("node");
    let script = resource(app, "wraps-connect.mjs")?;
    let mut child = Command::new(node)
        .arg(script)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start the connect helper: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        if let Some(text) = input { writeln!(stdin, "{text}").map_err(|e| e.to_string())?; }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let last = stdout.lines().last().and_then(|l| serde_json::from_str::<Value>(l).ok());
    if !out.status.success() {
        return Err(match last {
            Some(v) if v.get("error").is_some() => v.to_string(),
            _ => helper_error(&out.stderr),
        });
    }
    last.ok_or_else(|| "connect helper printed no result".into())
}

fn helper_error(stderr: &[u8]) -> String {
    let err = String::from_utf8_lossy(stderr);
    let line = err.lines().rev().find(|l| l.contains("Error") || l.contains("failed")).unwrap_or("connect helper failed");
    line.trim().chars().take(160).collect()
}

/// Reads the helper's next stdout line as JSON. On EOF, reports why the helper stopped.
fn next_json(child: &mut Child, out: &mut BufReader<ChildStdout>) -> Result<Value, String> {
    let mut line = String::new();
    out.read_line(&mut line).map_err(|e| e.to_string())?;
    if line.trim().is_empty() {
        let mut err = Vec::new();
        if let Some(mut e) = child.stderr.take() { let _ = std::io::Read::read_to_end(&mut e, &mut err); }
        let _ = child.wait();
        return Err(helper_error(&err));
    }
    serde_json::from_str(&line).map_err(|e| format!("bad helper output: {e}"))
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

/// The relay's IPv4 address, checked before it reaches the helper's argument list.
fn relay_ip(relay: &str) -> Result<&str, String> {
    relay.parse::<std::net::Ipv4Addr>().map(|_| relay).map_err(|_| "bad relay address".to_string())
}

#[tauri::command]
pub async fn vpn_attest(app: AppHandle, relay: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || helper(&app, &["--json", "--attest-only", "--relay", relay_ip(&relay)?], None))
        .await
        .map_err(|e| e.to_string())?
}

/// Writes the WireGuard config, brings the tunnel up, and returns the join result without the profile.
fn bring_up(app: &AppHandle, joined: Value) -> Result<Value, String> {
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
    let result = tunnel(app, &["up", &conf.to_string_lossy(), address, endpoint]);
    let _ = fs::remove_file(&conf); // the private key lives in the running tunnel now, not on disk
    result?;
    Ok(joined.as_object().map(|o| {
        let mut o = o.clone();
        o.remove("profile");
        Value::Object(o)
    }).unwrap_or(Value::Null))
}

/// Pays the relay with the wallet's kept tokens (10 MB each) and brings the tunnel up.
/// On failure the error is JSON with the tokens the relay did not take (`unspent`).
#[tauri::command]
pub async fn vpn_connect(app: AppHandle, tokens: Vec<String>, relay: String) -> Result<Value, String> {
    if tokens.is_empty() || tokens.len() > 20 { return Err("connect needs 1 to 20 tokens".into()); }
    tauri::async_runtime::spawn_blocking(move || {
        let kept = serde_json::to_string(&tokens).map_err(|e| e.to_string())?;
        let joined = helper(&app, &["--json", "--spend", "--relay", relay_ip(&relay)?], Some(&kept))?;
        // The relay has the tokens now: if the tunnel fails, none come back to the wallet.
        bring_up(&app, joined).map_err(|e| serde_json::json!({ "error": e, "unspent": [] }).to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Mock rail top-up: returns `{"tokens": [...]}` for the wallet to keep.
#[tauri::command]
pub async fn topup_mock(app: AppHandle, tokens: u32) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tokens = tokens.clamp(1, 200).to_string();
        helper(&app, &["--json", "--buy", &tokens], None)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// RLUSD top-up, step 1: verify the issuer and return its quote for the user's wallet to pay.
#[tauri::command]
pub async fn topup_quote(app: AppHandle, pending: State<'_, PendingJoin>, tokens: u32) -> Result<Value, String> {
    if let Some((mut old, _)) = pending.0.lock().unwrap().take() { let _ = old.kill(); let _ = old.wait(); }
    let (child, out, quote) = tauri::async_runtime::spawn_blocking(move || {
        let tokens = tokens.clamp(1, 200).to_string();
        let mut child = Command::new(bin_dir()?.join("node"))
            .arg(resource(&app, "wraps-connect.mjs")?)
            .args(["--json", "--buy", &tokens, "--pay", "rlusd"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("could not start the connect helper: {e}"))?;
        let mut out = BufReader::new(child.stdout.take().ok_or("no helper output")?);
        let first = next_json(&mut child, &mut out)?;
        let quote = first.get("quote").cloned().ok_or("helper sent no quote")?;
        Ok::<_, String>((child, out, quote))
    })
    .await
    .map_err(|e| e.to_string())??;
    *pending.0.lock().unwrap() = Some((child, out));
    Ok(quote)
}

/// RLUSD top-up, step 2: the quote is paid in `tx_hash`; returns `{"tokens": [...], "txHash"}`.
#[tauri::command]
pub async fn topup_paid(pending: State<'_, PendingJoin>, tx_hash: String) -> Result<Value, String> {
    let (mut child, mut out) = pending.0.lock().unwrap().take().ok_or("no quote is waiting for payment")?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut stdin = child.stdin.take().ok_or("helper input closed")?;
        writeln!(stdin, "{tx_hash}").map_err(|e| e.to_string())?;
        drop(stdin);
        let bought = next_json(&mut child, &mut out)?;
        let _ = child.wait();
        Ok(bought)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Stops a helper whose quote won't be paid.
#[tauri::command]
pub fn topup_cancel(pending: State<'_, PendingJoin>) {
    if let Some((mut child, _)) = pending.0.lock().unwrap().take() { let _ = child.kill(); let _ = child.wait(); }
}

#[tauri::command]
pub async fn vpn_disconnect(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || tunnel(&app, &["down"]))
        .await
        .map_err(|e| e.to_string())?
}

/// Opens a transaction (0x + 64 hex) or an address (0x + 40 hex) on the XRPL EVM testnet explorer.
#[tauri::command]
pub fn open_tx(tx_hash: String) -> Result<(), String> {
    let hex = tx_hash.starts_with("0x") && tx_hash[2..].chars().all(|c| c.is_ascii_hexdigit());
    let path = match tx_hash.len() {
        66 if hex => "tx",
        42 if hex => "address",
        _ => return Err("bad transaction hash or address".into()),
    };
    Command::new("open").arg(format!("https://explorer.testnet.xrplevm.org/{path}/{tx_hash}")).spawn().map_err(|e| e.to_string())?;
    Ok(())
}
