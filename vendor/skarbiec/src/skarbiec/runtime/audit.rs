// Tamper-evident audit journal. Each line records at/op/extra plus the hash of
// the previous line, forming a chain: any retroactive edit breaks every hash
// after it, which `verify-chain` detects. Values are never journalled — only
// operation names and non-sensitive identifiers.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::process::Command;

use crate::core::crypto;

fn audit_path() -> PathBuf {
    if let Ok(p) = std::env::var("SKARBIEC_AUDIT_FILE") {
        return PathBuf::from(p);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("skarbiec.audit.jsonl")
}

fn now_iso() -> String {
    Command::new("date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn lines() -> Result<Vec<Value>> {
    let path = audit_path();
    if !path.exists() {
        return Ok(Vec::new());
    }
    let body = std::fs::read_to_string(&path)?;
    let mut out = Vec::new();
    for line in body.lines() {
        if line.trim().is_empty() {
            continue;
        }
        out.push(serde_json::from_str(line).context("audit line is not JSON")?);
    }
    Ok(out)
}

// The material each line's hash covers: previous hash + the line's own fields.
fn digest_input(prev: &str, at: &str, op: &str, extra: &Value) -> String {
    format!("{prev}|{at}|{op}|{extra}")
}

/// Append one hash-chained entry. `prev` is the previous line's hash (empty for
/// the genesis line). Never records any stored value.
pub fn append(op: &str, extra: &Value) -> Result<()> {
    let existing = lines()?;
    let prev = existing.last().and_then(|e| e.get("hash")).and_then(Value::as_str).unwrap_or("").to_string();
    let at = now_iso();
    let hash = crypto::sha256_hex(&digest_input(&prev, &at, op, extra))?;
    let entry = json!({"at": at, "op": op, "extra": extra, "prev": prev, "hash": hash});
    let path = audit_path();
    let mut file = OpenOptions::new().create(true).append(true).open(&path)?;
    writeln!(file, "{entry}")?;
    Command::new("chmod").arg("600").arg(&path).status().ok();
    Ok(())
}

fn verify_chain() -> Result<Value> {
    let entries = lines()?;
    let mut prev = String::new();
    let mut broken_at: Option<String> = None;
    for entry in &entries {
        let at = entry.get("at").and_then(Value::as_str).unwrap_or("");
        let op = entry.get("op").and_then(Value::as_str).unwrap_or("");
        let extra = entry.get("extra").cloned().unwrap_or(Value::Null);
        let stored_prev = entry.get("prev").and_then(Value::as_str).unwrap_or("");
        let stored_hash = entry.get("hash").and_then(Value::as_str).unwrap_or("");
        let recomputed = crypto::sha256_hex(&digest_input(&prev, at, op, &extra))?;
        if stored_prev != prev || stored_hash != recomputed {
            broken_at = Some(at.to_string());
            break;
        }
        prev = stored_hash.to_string();
    }
    Ok(json!({
        "entries": entries.len(),
        "intact": broken_at.is_none(),
        "broken_at": broken_at,
    }))
}

pub fn dispatch(command: &str, _flags: &HashMap<String, String>, _positionals: &[String]) -> Result<Option<Value>> {
    match command {
        "audit" => Ok(Some(json!(lines()?))),
        "verify-chain" => Ok(Some(verify_chain()?)),
        _ => Ok(None),
    }
}
