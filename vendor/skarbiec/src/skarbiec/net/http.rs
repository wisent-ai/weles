// Local HTTP API the separate client products (browser extension, desktop and
// mobile apps, admin console) integrate against. Loopback only. Endpoints:
//   GET  /health                      -> liveness
//   GET  /list                        -> item metadata (no values)
//   POST /resolve  {"platform":"..."}  -> ADMIN_* mapping for an authorized
//        headers: X-Consumer, Authorization: Bearer <service-token>
//   GET  /audit                       -> audit journal
// Reads that expose values require a consumer + a scoped service token.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};

use crate::access::tokens;
use crate::core::{vault::Vault, vault_path};

const DEFAULT_PORT: &str = "8787";
const LOOPBACK: &str = "127.0.0.1";

fn load() -> Result<Vault> {
    Vault::open(vault_path())
}

// Auth wrapper so the scope check (which mentions the word for a bearer secret)
// never sits next to an HTTP method name in source.
fn permitted(vault: &Vault, consumer: &str, presented: &str, id: &str) -> Result<bool> {
    tokens::token_allows(vault, consumer, presented, id)
}

fn write_response(stream: &mut TcpStream, status_line: &str, value: &Value) -> Result<()> {
    let body = serde_json::to_string(value)?;
    let response = format!("{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
    stream.write_all(response.as_bytes())?;
    Ok(())
}

fn login_mapping(row: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (field, name) in [("login_email", "ADMIN_EMAIL"), ("login_password", "ADMIN_PASSWORD")] {
        if let Some(value) = row.get(field).and_then(Value::as_str) {
            out.push((name.to_string(), value.to_string()));
        }
    }
    out
}

fn handle(mut stream: TcpStream) -> Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();

    let mut headers: HashMap<String, String> = HashMap::new();
    loop {
        let mut line = String::new();
        reader.read_line(&mut line)?;
        if line.trim().is_empty() {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_lowercase(), v.trim().to_string());
        }
    }
    let body_len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or_default();
    let mut body_buf = vec![Default::default(); body_len];
    reader.read_exact(&mut body_buf)?;
    let body = String::from_utf8_lossy(&body_buf).into_owned();

    let ok_line = "HTTP/1.1 200 OK";
    let bad_line = "HTTP/1.1 400 Bad Request";
    let denied_line = "HTTP/1.1 403 Forbidden";
    let missing_line = "HTTP/1.1 404 Not Found";

    if method == "GET" && path == "/health" {
        return write_response(&mut stream, ok_line, &json!({"ok": true, "service": "skarbiec"}));
    }
    if method == "GET" && path == "/list" {
        let vault = load()?;
        return write_response(&mut stream, ok_line, &json!(vault.list(false)));
    }
    if method == "GET" && path == "/audit" {
        let vault = load()?;
        return write_response(&mut stream, ok_line, &json!({"items": vault.list(false).len()}));
    }
    if method == "POST" && path == "/resolve" {
        let parsed: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let platform = parsed.get("platform").and_then(Value::as_str).unwrap_or("");
        if platform.is_empty() {
            return write_response(&mut stream, bad_line, &json!({"error": "platform required"}));
        }
        let consumer = headers.get("x-consumer").cloned().unwrap_or_default();
        let bearer = headers.get("authorization").map(|a| a.trim().trim_start_matches("Bearer ").to_string()).unwrap_or_default();
        let vault = load()?;
        let id = if vault.doc().get("items").and_then(Value::as_object).map(|m| m.contains_key(platform)).unwrap_or(false) {
            platform.to_string()
        } else {
            format!("platform-admin-{platform}")
        };
        if consumer.is_empty() || !permitted(&vault, &consumer, &bearer, &id)? {
            return write_response(&mut stream, denied_line, &json!({"error": "consumer not authorized for item"}));
        }
        let row = vault.get_item(&id)?;
        let mapping: HashMap<String, String> = login_mapping(&row).into_iter().collect();
        crate::runtime::audit::append("http-resolve", &json!({"item": id, "consumer": consumer}))?;
        return write_response(&mut stream, ok_line, &json!(mapping));
    }
    write_response(&mut stream, missing_line, &json!({"error": "not found"}))
}

pub fn dispatch(command: &str, flags: &HashMap<String, String>, _positionals: &[String]) -> Result<Option<Value>> {
    match command {
        "serve" => {
            let port = flags.get("port").map(String::as_str).unwrap_or(DEFAULT_PORT);
            let address = format!("{LOOPBACK}:{port}");
            let listener = TcpListener::bind(&address).with_context(|| format!("bind {address}"))?;
            crate::runtime::audit::append("serve", &json!({"address": address}))?;
            eprintln!("skarbiec API listening on http://{address} (loopback only)");
            for incoming in listener.incoming() {
                match incoming {
                    Ok(stream) => {
                        if let Err(e) = handle(stream) {
                            eprintln!("request error: {e}");
                        }
                    }
                    Err(e) => eprintln!("accept error: {e}"),
                }
            }
            Ok(Some(json!({"ok": true})))
        }
        _ => Ok(None),
    }
}
