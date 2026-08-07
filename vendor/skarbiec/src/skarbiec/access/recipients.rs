// Per-user recipients and cryptographic sharing. Adding a user gives them a gpg
// key; sharing an item re-encrypts it to include their key; revoking re-encrypts
// to the remaining recipients (plus the always-present owner + recovery keys).

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::core::{crypto, vault::Vault, vault_path};

// Item type + tags as stored, so a re-encrypt preserves them.
fn item_meta(vault: &Vault, id: &str) -> Result<(String, Vec<String>)> {
    let item = vault.doc().get("items").and_then(|m| m.get(id)).with_context(|| format!("no item: {id}"))?;
    let item_type = item.get("type").and_then(Value::as_str).unwrap_or("login").to_string();
    let tags = item.get("tags").and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
        .unwrap_or_default();
    Ok((item_type, tags))
}

pub fn dispatch(command: &str, flags: &HashMap<String, String>, positionals: &[String]) -> Result<Option<Value>> {
    match command {
        "add-user" => {
            let mut args = positionals.iter();
            let uid = args.next().context("usage: add-user <uid> [--import <pubkey-file>] [--role r]")?;
            let role = flags.get("role").map(String::as_str).unwrap_or("member");
            let fpr = match flags.get("import") {
                Some(file) => {
                    let armored = std::fs::read_to_string(file).with_context(|| format!("read {file}"))?;
                    crypto::import_key(&armored)?;
                    crypto::fingerprint_for(uid)?.with_context(|| format!("imported key has no uid match for {uid}"))?
                }
                None => match crypto::fingerprint_for(uid)? {
                    Some(existing) => existing,
                    None => crypto::generate_key(uid)?,
                },
            };
            let mut vault = Vault::open(vault_path())?;
            vault.register_recipient(uid, &fpr, role)?;
            crate::runtime::audit::append("add-user", &json!({"uid": uid, "role": role}))?;
            Ok(Some(json!({"ok": true, "uid": uid, "fingerprint": fpr, "role": role})))
        }
        "share" => {
            let mut args = positionals.iter();
            let id = args.next().context("usage: share <item-id> <uid>")?;
            let uid = args.next().context("usage: share <item-id> <uid>")?;
            let mut vault = Vault::open(vault_path())?;
            if vault.recipient_fpr(uid).is_none() {
                return Ok(Some(json!({"status": "blocked", "reason": "unknown_recipient", "uid": uid})));
            }
            let (item_type, tags) = item_meta(&vault, id)?;
            let secret = vault.get_item(id)?;
            let mut recipients = vault.item_recipient_uids(id);
            if !recipients.iter().any(|r| r == uid) {
                recipients.push(uid.clone());
            }
            vault.set_item(id, &item_type, &secret, &recipients, &tags)?;
            crate::runtime::audit::append("share", &json!({"item": id, "uid": uid}))?;
            Ok(Some(json!({"ok": true, "item": id, "recipients": recipients})))
        }
        "revoke" => {
            let mut args = positionals.iter();
            let id = args.next().context("usage: revoke <item-id> <uid>")?;
            let uid = args.next().context("usage: revoke <item-id> <uid>")?;
            let mut vault = Vault::open(vault_path())?;
            let (item_type, tags) = item_meta(&vault, id)?;
            let secret = vault.get_item(id)?;
            let recipients: Vec<String> = vault.item_recipient_uids(id).into_iter().filter(|r| r != uid).collect();
            vault.set_item(id, &item_type, &secret, &recipients, &tags)?;
            crate::runtime::audit::append("revoke", &json!({"item": id, "uid": uid}))?;
            Ok(Some(json!({"ok": true, "item": id, "recipients": recipients})))
        }
        "users" => {
            let vault = Vault::open(vault_path())?;
            let users = vault.doc().get("recipients").cloned().unwrap_or_else(|| json!({}));
            Ok(Some(users))
        }
        "export-key" => {
            let uid = positionals.first().context("usage: export-key <uid>")?;
            let vault = Vault::open(vault_path())?;
            let fpr = vault.recipient_fpr(uid).with_context(|| format!("unknown recipient: {uid}"))?;
            Ok(Some(json!({"uid": uid, "public_key": crypto::export_public_key(&fpr)?})))
        }
        _ => Ok(None),
    }
}
