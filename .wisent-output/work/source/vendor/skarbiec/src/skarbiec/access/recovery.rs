// Recovery + emergency access.
//
// Recovery: the recovery recipient is on every item (see core::vault), so
// losing the day-to-day identity never loses data — the offline recovery
// material still opens everything. `recovery-status` reports it.
//
// Emergency access: grant a registered user access that becomes active only at
// or after an operator-set timestamp, unless cancelled first. Activation shares
// every live item with the grantee by re-encrypting to include their identity.
// Timestamps are ISO-8601 and compared as strings (which sorts chronologically),
// so there is no numeric time arithmetic here.

use anyhow::{Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::process::Command;

use crate::core::{vault::Vault, vault_path};

fn load() -> Result<Vault> {
    Vault::open(vault_path())
}

fn now_iso() -> String {
    Command::new("date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

fn ensure_section<'a>(doc: &'a mut Value, key: &str) -> &'a mut serde_json::Map<String, Value> {
    let object = doc.as_object_mut().expect("vault doc is object");
    object.entry(key).or_insert_with(|| json!({}));
    object.get_mut(key).and_then(Value::as_object_mut).expect("section is object")
}

pub fn dispatch(command: &str, flags: &HashMap<String, String>, positionals: &[String]) -> Result<Option<Value>> {
    match command {
        "recovery-status" => {
            let vault = load()?;
            let items = vault.doc().get("items").and_then(Value::as_object).map(|m| m.len()).unwrap_or_default();
            Ok(Some(json!({
                "recovery_fpr": vault.recovery_fpr(),
                "note": "recovery recipient is on every item; keep its offline material stored safely",
                "item_count": items,
            })))
        }
        "emergency-grant" => {
            let grantee = positionals.first().context("usage: emergency-grant <grantee> --activate-after <iso>")?;
            let activate_after = flags.get("activate-after").context("--activate-after <iso8601> required")?;
            let mut vault = load()?;
            if vault.recipient_fpr(grantee).is_none() {
                return Ok(Some(json!({"status": "blocked", "reason": "unknown_recipient", "grantee": grantee})));
            }
            let stamp = now_iso();
            ensure_section(vault.doc_mut(), "emergency").insert(grantee.clone(), json!({
                "activate_after": activate_after,
                "granted_at": stamp,
                "status": "pending",
            }));
            vault.save()?;
            crate::runtime::audit::append("emergency-grant", &json!({"grantee": grantee, "activate_after": activate_after}))?;
            Ok(Some(json!({"ok": true, "grantee": grantee, "activate_after": activate_after})))
        }
        "emergency-cancel" => {
            let grantee = positionals.first().context("usage: emergency-cancel <grantee>")?;
            let mut vault = load()?;
            ensure_section(vault.doc_mut(), "emergency").remove(grantee);
            vault.save()?;
            crate::runtime::audit::append("emergency-cancel", &json!({"grantee": grantee}))?;
            Ok(Some(json!({"ok": true, "grantee": grantee})))
        }
        "emergency-list" => {
            let vault = load()?;
            Ok(Some(vault.doc().get("emergency").cloned().unwrap_or_else(|| json!({}))))
        }
        "emergency-activate" => {
            let grantee = positionals.first().context("usage: emergency-activate <grantee>")?;
            let mut vault = load()?;
            let activate_after = vault.doc().get("emergency").and_then(|e| e.get(grantee)).and_then(|g| g.get("activate_after")).and_then(Value::as_str)
                .with_context(|| format!("no emergency grant for {grantee}"))?.to_string();
            let current = now_iso();
            if current < activate_after {
                return Ok(Some(json!({"status": "not_yet", "grantee": grantee, "activate_after": activate_after, "now": current})));
            }
            let ids: Vec<String> = vault.doc().get("items").and_then(Value::as_object)
                .map(|m| m.iter().filter(|(_, it)| !it.get("deleted").and_then(Value::as_bool).unwrap_or(false)).map(|(id, _)| id.clone()).collect())
                .unwrap_or_default();
            let mut shared = Vec::new();
            for id in &ids {
                let item = vault.doc().get("items").and_then(|m| m.get(id)).cloned().unwrap_or_else(|| json!({}));
                let item_type = item.get("type").and_then(Value::as_str).unwrap_or("login").to_string();
                let tags: Vec<String> = item.get("tags").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
                let secret = vault.get_item(id)?;
                let mut recipients = vault.item_recipient_uids(id);
                if !recipients.iter().any(|r| r == grantee) {
                    recipients.push(grantee.clone());
                }
                vault.set_item(id, &item_type, &secret, &recipients, &tags)?;
                shared.push(id.clone());
            }
            ensure_section(vault.doc_mut(), "emergency").get_mut(grantee).and_then(Value::as_object_mut)
                .context("emergency entry")?.insert("status".to_string(), json!("activated"));
            vault.save()?;
            crate::runtime::audit::append("emergency-activate", &json!({"grantee": grantee, "items": shared.len()}))?;
            Ok(Some(json!({"ok": true, "grantee": grantee, "shared_items": shared})))
        }
        _ => Ok(None),
    }
}
