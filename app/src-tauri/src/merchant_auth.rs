use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use keyring::Entry;
use rand::rngs::OsRng;
use rand::RngCore;
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

const KEYCHAIN_SERVICE: &str = "com.wraps.app.merchant-auth";
const KEYCHAIN_ACCOUNT: &str = "ed25519-seed-v1";
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];

static KEYCHAIN_LOCK: Mutex<()> = Mutex::new(());

/// Sign the exact HTTP body and path accepted by the issuer's SEC-04 verifier.
#[tauri::command]
pub async fn merchant_auth_headers(
    merchant_id: String,
    method: String,
    path: String,
    body: String,
) -> Result<BTreeMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(move || sign_headers(&merchant_id, &method, &path, &body))
        .await
        .map_err(|_| "merchant signing task failed".to_string())?
}

/// Return the public SPKI key for the immutable issuer merchant-key map.
/// The private seed is generated once and stored in the OS credential store.
#[tauri::command]
pub async fn merchant_auth_public_key() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let key = signing_key()?;
        let mut spki = Vec::with_capacity(ED25519_SPKI_PREFIX.len() + 32);
        spki.extend_from_slice(&ED25519_SPKI_PREFIX);
        spki.extend_from_slice(&key.verifying_key().to_bytes());
        Ok(URL_SAFE_NO_PAD.encode(spki))
    })
    .await
    .map_err(|_| "merchant public-key task failed".to_string())?
}

fn sign_headers(
    merchant_id: &str,
    method: &str,
    path: &str,
    body: &str,
) -> Result<BTreeMap<String, String>, String> {
    if merchant_id.is_empty() || merchant_id.len() > 128 || merchant_id.contains(['\n', '\r']) {
        return Err("invalid merchant ID".into());
    }
    if method != "POST" || !matches!(path, "/settle" | "/settle/status") {
        return Err("unsupported merchant-auth request".into());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "system clock is before the Unix epoch")?
        .as_millis();
    let mut nonce = [0u8; 16];
    OsRng.fill_bytes(&mut nonce);
    let nonce = URL_SAFE_NO_PAD.encode(nonce);
    let message = request_message(merchant_id, method, path, body, timestamp, &nonce);
    let signature = signing_key()?.sign(&message);

    let mut headers = BTreeMap::new();
    headers.insert(
        "x-wraps-merchant-signature".into(),
        URL_SAFE_NO_PAD.encode(signature.to_bytes()),
    );
    headers.insert("x-wraps-merchant-timestamp".into(), timestamp.to_string());
    headers.insert("x-wraps-merchant-nonce".into(), nonce);
    Ok(headers)
}

fn request_message(
    merchant_id: &str,
    method: &str,
    path: &str,
    body: &str,
    timestamp: u128,
    nonce: &str,
) -> Vec<u8> {
    let body_hash = Sha256::digest(body.as_bytes());
    let body_hash_hex = body_hash
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!(
        "wraps-merchant-auth-v1\n{merchant_id}\n{}\n{path}\n{body_hash_hex}\n{timestamp}\n{nonce}",
        method.to_uppercase(),
    )
    .into_bytes()
}

fn signing_key() -> Result<SigningKey, String> {
    let _lock = KEYCHAIN_LOCK.lock().map_err(|_| "merchant keychain lock failed")?;
    let entry = Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
        .map_err(|_| "OS keychain is unavailable for merchant authentication")?;

    let mut seed = match entry.get_secret() {
        Ok(seed) => seed,
        Err(keyring::Error::NoEntry) => {
            let mut seed = [0u8; 32];
            OsRng.fill_bytes(&mut seed);
            if entry.set_secret(&seed).is_err() {
                seed.zeroize();
                return Err("could not store merchant key in the OS keychain".into());
            }
            let saved = seed.to_vec();
            seed.zeroize();
            saved
        }
        Err(_) => return Err("could not read merchant key from the OS keychain".into()),
    };

    if seed.len() != 32 {
        seed.zeroize();
        return Err("stored merchant key is invalid".into());
    }
    let mut seed_array = [0u8; 32];
    seed_array.copy_from_slice(&seed);
    seed.zeroize();
    let key = SigningKey::from_bytes(&seed_array);
    seed_array.zeroize();
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_matches_the_issuer_framing() {
        let body = r#"{"merchantId":"node:usc1","quoteId":"abc","tokens":["t"]}"#;
        let actual = String::from_utf8(request_message(
            "node:usc1",
            "POST",
            "/settle",
            body,
            123,
            "nonce",
        ))
        .expect("message is UTF-8");
        let body_hash = Sha256::digest(body.as_bytes());
        let body_hash_hex = body_hash
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(
            actual,
            format!("wraps-merchant-auth-v1\nnode:usc1\nPOST\n/settle\n{body_hash_hex}\n123\nnonce")
        );
    }

    #[test]
    fn public_key_der_prefix_is_ed25519_spki() {
        assert_eq!(
            &ED25519_SPKI_PREFIX,
            &[0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]
        );
    }
}
