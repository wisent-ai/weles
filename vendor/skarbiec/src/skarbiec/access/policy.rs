// Administrative policy for the vault: organization rules enforced before the
// relevant operation. Stored in the vault's `policy` section.
//   min_generated_length : shortest length the generator may produce
//   require_totp         : item ids (globs) that must carry a one-time-code seed
//   consumer scope globs  : enforced by the tokens module
// Vocabulary here is deliberately neutral to keep policy metadata clear.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::core::{vault::Vault, vault_path};

fn load() -> Result<Vault> {
    Vault::open(vault_path())
}

fn ensure_section<'a>(doc: &'a mut Value, key: &str) -> &'a mut serde_json::Map<String, Value> {
    let object = doc.as_object_mut().expect("vault doc is object");
    object.entry(key).or_insert_with(|| json!({}));
    object.get_mut(key).and_then(Value::as_object_mut).expect("section is object")
}

// Minimum generated length the policy requires, if configured.
pub fn min_generated_length(vault: &Vault) -> Option<usize> {
    vault.doc().get("policy").and_then(|p| p.get("min_generated_length")).and_then(Value::as_u64).map(|n| n as usize)
}

/// Interpret a policy value string as bool / number / string (in that order).
fn coerce(raw: &str) -> Value {
    if raw == "true" || raw == "false" {
        return json!(raw == "true");
    }
    if let Ok(n) = raw.parse::<u64>() {
        return json!(n);
    }
    json!(raw)
}

pub fn dispatch(command: &str, _flags: &HashMap<String, String>, positionals: &[String]) -> Result<Option<Value>> {
    match command {
        "policy-set" => {
            let mut args = positionals.iter();
            let key = args.next().context("usage: policy-set <key> <value>")?;
            let raw = args.next().context("usage: policy-set <key> <value>")?;
            let mut vault = load()?;
            ensure_section(vault.doc_mut(), "policy").insert(key.clone(), coerce(raw));
            vault.save()?;
            crate::runtime::audit::append("policy-set", &json!({"key": key}))?;
            Ok(Some(json!({"ok": true, "key": key})))
        }
        "policy-get" => {
            let vault = load()?;
            Ok(Some(vault.doc().get("policy").cloned().unwrap_or_else(|| json!({}))))
        }
        // Check a candidate string against the configured minimum length. Used
        // by generation and by operators validating a value before storing it.
        "policy-check-length" => {
            let candidate = positionals.first().context("usage: policy-check-length <candidate>")?;
            let vault = load()?;
            let length = candidate.chars().count();
            let verdict = match min_generated_length(&vault) {
                Some(minimum) => json!({"required": minimum, "actual": length, "ok": length >= minimum}),
                None => json!({"required": Value::Null, "actual": length, "ok": true}),
            };
            Ok(Some(verdict))
        }
        _ => Ok(None),
    }
}
