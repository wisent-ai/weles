// Runtime credential resolution + reference expansion (like `op run` / `bws run`).
//   resolve: gate by consumer scope, decrypt one item, optionally write a
//     mode-0600 shell file of ADMIN_* variables (names returned; values only in file).
//   expand: replace `NAME=skarbiec://<id>/<field>` lines with decrypted values.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

use crate::access::tokens;
use crate::core::{vault::Vault, vault_path};

fn load() -> Result<Vault> {
    Vault::open(vault_path())
}

// (stored-field, exported-name) pairs, kept away from any output verb.
fn name_table() -> Vec<(&'static str, &'static str)> {
    vec![("login_email", "ADMIN_EMAIL"), ("login_password", "ADMIN_PASSWORD")]
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn chmod_600(path: &PathBuf) {
    Command::new("chmod").arg("600").arg(path).status().ok();
}

// Canonical exported mapping from a decrypted item: login pair plus a one-time
// code seed if present in metadata.
fn mapping_for(row: &Value) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for (field, name) in name_table() {
        if let Some(value) = row.get(field).and_then(Value::as_str) {
            out.push((name.to_string(), value.to_string()));
        }
    }
    let meta = row.get("metadata");
    let seed = meta.and_then(|m| m.get("totp_secret")).or_else(|| meta.and_then(|m| m.get("google_totp_secret"))).and_then(Value::as_str);
    if let Some(code_seed) = seed {
        out.push(("ADMIN_TOTP".to_string(), code_seed.to_string()));
    }
    out
}

fn normalize_id(vault: &Vault, target: &str) -> String {
    let known = vault.doc().get("items").and_then(Value::as_object).map(|m| m.contains_key(target)).unwrap_or(false);
    if known {
        target.to_string()
    } else {
        format!("platform-admin-{target}")
    }
}

pub fn dispatch(command: &str, flags: &HashMap<String, String>, positionals: &[String]) -> Result<Option<Value>> {
    match command {
        "resolve" => {
            let target = positionals.first().context("usage: resolve <platform> [--consumer c --token t] [--emit --out dir]")?;
            let vault = load()?;
            let id = normalize_id(&vault, target);
            let consumer = flags.get("consumer");
            if let Some(name) = consumer {
                let presented = flags.get("token").context("--token required with --consumer")?;
                if !tokens::token_allows(&vault, name, presented, &id)? {
                    return Ok(Some(json!({"status": "blocked", "platform": id, "consumer": name, "reason": "token_denies_consumer"})));
                }
            }
            let known = vault.doc().get("items").and_then(Value::as_object).map(|m| m.contains_key(&id)).unwrap_or(false);
            if !known {
                return Ok(Some(json!({"status": "blocked", "platform": id, "reason": "no_stored_credential"})));
            }
            let row = vault.get_item(&id)?;
            let mapping = mapping_for(&row);
            let names: Vec<String> = mapping.iter().map(|(name, _)| name.clone()).collect();
            if flags.get("emit").map(|v| v == "true").unwrap_or(false) {
                let dir = PathBuf::from(flags.get("out").map(String::as_str).unwrap_or(".vault-resolved"));
                std::fs::create_dir_all(&dir)?;
                let out_file = dir.join(format!("{id}.env"));
                let body = mapping.iter().map(|(name, value)| format!("{name}={}", shell_quote(value))).collect::<Vec<_>>().join("\n");
                std::fs::write(&out_file, format!("{body}\n"))?;
                chmod_600(&out_file);
                crate::runtime::audit::append("resolve", &json!({"item": id, "consumer": consumer, "names": names}))?;
                return Ok(Some(json!({"status": "ready", "platform": id, "out_file": out_file.display().to_string(), "names": names})));
            }
            Ok(Some(json!({"status": "ready", "platform": id, "names": names, "login_method": row.get("login_method")})))
        }
        "expand" => {
            let template = positionals.first().context("usage: expand <template> --out <file>")?;
            let out = flags.get("out").context("--out <file> required")?;
            let body = std::fs::read_to_string(template).with_context(|| format!("read {template}"))?;
            let vault = load()?;
            let mut result = String::new();
            for line in body.lines() {
                match line.split_once("=skarbiec://") {
                    Some((name, reference)) => {
                        let (id, field) = reference.rsplit_once('/').context("reference must be skarbiec://<id>/<field>")?;
                        let row = vault.get_item(id)?;
                        let value = row.get(field).and_then(Value::as_str).with_context(|| format!("{id} has no field {field}"))?;
                        result.push_str(&format!("{name}={}\n", shell_quote(value)));
                    }
                    None => {
                        result.push_str(line);
                        result.push('\n');
                    }
                }
            }
            let out_path = PathBuf::from(out);
            std::fs::write(&out_path, result)?;
            chmod_600(&out_path);
            crate::runtime::audit::append("expand", &json!({"template": template, "out": out}))?;
            Ok(Some(json!({"status": "ready", "out_file": out})))
        }
        _ => Ok(None),
    }
}
