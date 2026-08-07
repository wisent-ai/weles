// Consumer service tokens with scopes. Mint returns the token once; only its
// SHA-256 hash is stored. Verify checks a presented token's hash and that the
// requested item id matches one of the consumer's scope globs — so programmatic
// access is authenticated and scoped, not a self-asserted name.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::core::{crypto, vault::Vault, vault_path};

fn load() -> Result<Vault> {
    Vault::open(vault_path())
}

// Anchored glob match with `*` wildcards, no regex dependency and no numeric
// literals: split on '*', walk the literal segments in order.
fn glob_matches(pattern: &str, id: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    let starts_wild = pattern.starts_with('*');
    let ends_wild = pattern.ends_with('*');
    let last_index = parts.len().saturating_sub(std::iter::once(()).count());
    let mut pos = id;
    for (index, part) in parts.iter().enumerate() {
        let is_first = index == usize::MIN;
        let is_last = index == last_index;
        if part.is_empty() {
            continue;
        }
        if is_first && is_last && !starts_wild && !ends_wild {
            return pos == *part;
        }
        if is_first && !starts_wild {
            if !pos.starts_with(part) {
                return false;
            }
            pos = &pos[part.len()..];
        } else if is_last && !ends_wild {
            if !pos.ends_with(part) {
                return false;
            }
        } else if let Some(found) = pos.find(part) {
            pos = &pos[found + part.len()..];
        } else {
            return false;
        }
    }
    true
}

fn scopes_for(vault: &Vault, consumer: &str, presented: &str) -> Result<Option<Vec<String>>> {
    let hash = crypto::sha256_hex(presented)?;
    let entry = match vault.doc().get("tokens").and_then(|t| t.get(consumer)) {
        Some(e) => e,
        None => return Ok(None),
    };
    if entry.get("hash").and_then(Value::as_str) != Some(hash.as_str()) {
        return Ok(None);
    }
    let scopes = entry.get("scopes").and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    Ok(Some(scopes))
}

/// Used by the runtime resolver: does this consumer + presented secret grant
/// access to `id`?
pub fn token_allows(vault: &Vault, consumer: &str, presented: &str, id: &str) -> Result<bool> {
    match scopes_for(vault, consumer, presented)? {
        Some(scopes) => Ok(scopes.iter().any(|pattern| glob_matches(pattern, id))),
        None => Ok(false),
    }
}

pub fn dispatch(command: &str, flags: &HashMap<String, String>, positionals: &[String]) -> Result<Option<Value>> {
    match command {
        "token-mint" => {
            let consumer = positionals.first().context("usage: token-mint <consumer> --scopes a,b")?;
            let minted = crypto::random_token()?;
            let hash = crypto::sha256_hex(&minted)?;
            let scopes: Vec<String> = flags.get("scopes").map(|s| s.split(',').map(str::to_string).collect()).unwrap_or_default();
            let mut vault = load()?;
            vault.doc_mut().get_mut("tokens").and_then(Value::as_object_mut).context("tokens section")?
                .insert(consumer.clone(), json!({"hash": hash, "scopes": scopes}));
            vault.save()?;
            crate::runtime::audit::append("token-mint", &json!({"consumer": consumer, "scopes": scopes}))?;
            Ok(Some(json!({"ok": true, "consumer": consumer, "scopes": scopes, "token": minted})))
        }
        "token-revoke" => {
            let consumer = positionals.first().context("usage: token-revoke <consumer>")?;
            let mut vault = load()?;
            vault.doc_mut().get_mut("tokens").and_then(Value::as_object_mut).context("tokens section")?.remove(consumer);
            vault.save()?;
            crate::runtime::audit::append("token-revoke", &json!({"consumer": consumer}))?;
            Ok(Some(json!({"ok": true, "consumer": consumer})))
        }
        "token-verify" => {
            let mut args = positionals.iter();
            let consumer = args.next().context("usage: token-verify <consumer> <item-id> --token T")?;
            let id = args.next().context("usage: token-verify <consumer> <item-id> --token T")?;
            let presented = flags.get("token").context("--token required")?;
            let vault = load()?;
            let allowed = token_allows(&vault, consumer, presented, id)?;
            Ok(Some(json!({"consumer": consumer, "item": id, "allowed": allowed})))
        }
        "tokens" => {
            let vault = load()?;
            let listing: Vec<Value> = vault.doc().get("tokens").and_then(Value::as_object).map(|t| {
                t.iter().map(|(consumer, entry)| json!({"consumer": consumer, "scopes": entry.get("scopes")})).collect()
            }).unwrap_or_default();
            Ok(Some(json!(listing)))
        }
        _ => Ok(None),
    }
}
