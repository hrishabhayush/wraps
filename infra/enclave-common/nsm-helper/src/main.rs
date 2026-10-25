//! nsm-attest: ask the Nitro Security Module for an attestation document.
//!
//! Usage:
//!   nsm-attest [--nonce HEX] [--user-data HEX] [--public-key HEX]
//!
//! On success it prints the COSE_Sign1 document as lowercase hex on one line
//! and exits 0. On failure it prints a reason on stderr and exits non-zero.
//! The Node helper in ../src/nsm.ts calls this binary.

use aws_nitro_enclaves_nsm_api::api::{Request, Response};
use aws_nitro_enclaves_nsm_api::driver::{nsm_exit, nsm_init, nsm_process_request};
use serde_bytes::ByteBuf;
use std::fmt::Write as _;
use std::process::ExitCode;

fn decode_hex(s: &str) -> Result<Vec<u8>, String> {
    if !s.is_ascii() || s.len() % 2 != 0 {
        return Err("expected an even number of hex digits".into());
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| e.to_string()))
        .collect()
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut nonce = None;
    let mut user_data = None;
    let mut public_key = None;

    let mut it = args.iter();
    while let Some(flag) = it.next() {
        let Some(value) = it.next() else {
            eprintln!("nsm-attest: missing value for {flag}");
            return ExitCode::from(2);
        };
        let bytes = match decode_hex(value) {
            Ok(b) => ByteBuf::from(b),
            Err(e) => {
                eprintln!("nsm-attest: {flag}: {e}");
                return ExitCode::from(2);
            }
        };
        match flag.as_str() {
            "--nonce" => nonce = Some(bytes),
            "--user-data" => user_data = Some(bytes),
            "--public-key" => public_key = Some(bytes),
            other => {
                eprintln!("nsm-attest: unknown flag {other}");
                return ExitCode::from(2);
            }
        }
    }

    let fd = nsm_init();
    if fd < 0 {
        eprintln!("nsm-attest: cannot open /dev/nsm (not inside a Nitro Enclave?)");
        return ExitCode::from(1);
    }
    let response = nsm_process_request(
        fd,
        Request::Attestation {
            user_data,
            nonce,
            public_key,
        },
    );
    nsm_exit(fd);

    match response {
        Response::Attestation { document } => {
            let mut out = String::with_capacity(document.len() * 2);
            for b in &document {
                let _ = write!(out, "{b:02x}");
            }
            println!("{out}");
            ExitCode::SUCCESS
        }
        Response::Error(code) => {
            eprintln!("nsm-attest: NSM returned an error: {code:?}");
            ExitCode::from(1)
        }
        _ => {
            eprintln!("nsm-attest: unexpected NSM response");
            ExitCode::from(1)
        }
    }
}
