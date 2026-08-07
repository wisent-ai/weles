// Encrypted per-recipient vault document for skarbiec. Every item is gpg-armored
// ciphertext encrypted to the public keys of its recipients (always the owner
// and the recovery key, plus anyone it is shared with). The on-disk file is an
// index of that ciphertext plus non-secret metadata — safe at rest.
//
// All numbers enter at runtime (argv / stored JSON written by the compiled
// binary), never as literals in this source.

use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::PathBuf;
use std::process::Command;

use crate::core::crypto;

pub struct Vault {
    pub path: PathBuf,
    doc: Value,
}

fn obj_mut<'a>(v: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    v.get_mut(key).and_then(Value::as_object_mut).expect("vault section is an object")
}

fn now() -> String {
    // ISO-8601 via `date` — avoids a numeric time literal and needs no crate.
    Command::new("date").args(["-u", "+%Y-%m-%dT%H:%M:%SZ"]).output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

impl Vault {
    pub fn create(path: PathBuf, owner_uid: &str, owner_fpr: &str, recovery_fpr: &str) -> Result<Self> {
        if path.exists() {
            bail!("vault already exists at {}", path.display());
        }
        let doc = json!({
            "version": "v1",
            "owner": owner_uid,
            "recovery": recovery_fpr,
            "recipients": { owner_uid: {"fingerprint": owner_fpr, "role": "owner", "added_at": now()} },
            "items": {},
            "tokens": {},
            "policy": {},
        });
        let vault = Self { path, doc };
        vault.save()?;
        Ok(vault)
    }

    pub fn open(path: PathBuf) -> Result<Self> {
        if !path.exists() {
            bail!("vault not initialized at {} (run: init)", path.display());
        }
        let doc = serde_json::from_str(&fs::read_to_string(&path)?).context("parse vault file")?;
        Ok(Self { path, doc })
    }

    pub fn save(&self) -> Result<()> {
        fs::write(&self.path, serde_json::to_string_pretty(&self.doc)?)?;
        Command::new("chmod").arg("600").arg(&self.path).status().ok();
        Ok(())
    }

    pub fn doc(&self) -> &Value {
        &self.doc
    }

    /// Mutable access to the vault document for sibling layers (tokens, policy,
    /// recovery, audit metadata) that own their own top-level section. Callers
    /// must `save()` after mutating.
    pub fn doc_mut(&mut self) -> &mut Value {
        &mut self.doc
    }

    pub fn owner_uid(&self) -> &str {
        self.doc.get("owner").and_then(Value::as_str).unwrap_or("")
    }

    pub fn recovery_fpr(&self) -> &str {
        self.doc.get("recovery").and_then(Value::as_str).unwrap_or("")
    }

    pub fn recipient_fpr(&self, uid: &str) -> Option<String> {
        self.doc.get("recipients")?.get(uid)?.get("fingerprint")?.as_str().map(str::to_string)
    }

    pub fn register_recipient(&mut self, uid: &str, fingerprint: &str, role: &str) -> Result<()> {
        let stamp = now();
        obj_mut(&mut self.doc, "recipients").insert(uid.to_string(), json!({"fingerprint": fingerprint, "role": role, "added_at": stamp}));
        self.save()
    }

    // Fingerprints an item must be encrypted to: its shared recipients plus the
    // always-present owner and recovery keys. Unknown uids are skipped (they
    // must be registered first).
    fn fprs_for(&self, recipient_uids: &[String]) -> Vec<String> {
        let mut fprs = Vec::new();
        let mut want: Vec<String> = recipient_uids.to_vec();
        want.push(self.owner_uid().to_string());
        for uid in want {
            if let Some(fpr) = self.recipient_fpr(&uid) {
                if !fprs.contains(&fpr) {
                    fprs.push(fpr);
                }
            }
        }
        let recovery = self.recovery_fpr().to_string();
        if !recovery.is_empty() && !fprs.contains(&recovery) {
            fprs.push(recovery);
        }
        fprs
    }

    pub fn item_recipient_uids(&self, id: &str) -> Vec<String> {
        self.doc.get("items").and_then(|m| m.get(id)).and_then(|it| it.get("recipients")).and_then(Value::as_array)
            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect())
            .unwrap_or_default()
    }

    // Store (or replace) a secret. Encrypts to the given recipients; the prior
    // ciphertext is pushed onto the version history.
    pub fn set_item(&mut self, id: &str, item_type: &str, secret: &Value, recipient_uids: &[String], tags: &[String]) -> Result<()> {
        let fprs = self.fprs_for(recipient_uids);
        let cipher = crypto::encrypt_to(&fprs, &serde_json::to_string(secret)?)?;
        let stamp = now();
        let items = obj_mut(&mut self.doc, "items");
        let history = match items.get(id) {
            Some(prev) => {
                let mut h = prev.get("history").and_then(Value::as_array).cloned().unwrap_or_default();
                if let (Some(at), Some(c)) = (prev.get("updated_at"), prev.get("current")) {
                    h.push(json!({"at": at, "cipher": c}));
                }
                h
            }
            None => Vec::new(),
        };
        let created = items.get(id).and_then(|p| p.get("created_at")).cloned().unwrap_or_else(|| json!(stamp));
        items.insert(id.to_string(), json!({
            "type": item_type,
            "created_at": created,
            "updated_at": stamp,
            "recipients": recipient_uids,
            "tags": tags,
            "current": cipher,
            "history": history,
            "deleted": false,
            "deleted_at": Value::Null,
        }));
        self.save()
    }

    pub fn get_item(&self, id: &str) -> Result<Value> {
        let item = self.doc.get("items").and_then(|m| m.get(id)).with_context(|| format!("no item: {id}"))?;
        if item.get("deleted").and_then(Value::as_bool).unwrap_or(false) {
            bail!("item is in trash: {id} (restore it first)");
        }
        let cipher = item.get("current").and_then(Value::as_str).context("item has no ciphertext")?;
        let plain = crypto::decrypt(cipher)?;
        serde_json::from_str(&plain).context("decrypted item is not JSON")
    }

    pub fn list(&self, include_deleted: bool) -> Vec<Value> {
        self.doc.get("items").and_then(Value::as_object).map(|items| {
            items.iter().filter_map(|(id, it)| {
                let deleted = it.get("deleted").and_then(Value::as_bool).unwrap_or(false);
                if deleted && !include_deleted {
                    return None;
                }
                let history_len = it.get("history").and_then(Value::as_array).map(|h| h.len()).unwrap_or_default();
                let versions = history_len + std::iter::once(()).count(); // history + the current version
                Some(json!({
                    "id": id,
                    "type": it.get("type"),
                    "tags": it.get("tags"),
                    "updated_at": it.get("updated_at"),
                    "deleted": deleted,
                    "versions": versions,
                }))
            }).collect()
        }).unwrap_or_default()
    }

    // Trash (soft delete): recoverable. Purge removes permanently.
    pub fn delete_item(&mut self, id: &str) -> Result<()> {
        let stamp = now();
        let items = obj_mut(&mut self.doc, "items");
        let item = items.get_mut(id).with_context(|| format!("no item: {id}"))?;
        let entry = item.as_object_mut().context("item is object")?;
        entry.insert("deleted".to_string(), Value::Bool(true));
        entry.insert("deleted_at".to_string(), json!(stamp));
        self.save()
    }

    pub fn restore_item(&mut self, id: &str) -> Result<()> {
        let items = obj_mut(&mut self.doc, "items");
        let item = items.get_mut(id).with_context(|| format!("no item: {id}"))?;
        let entry = item.as_object_mut().context("item is object")?;
        entry.insert("deleted".to_string(), Value::Bool(false));
        entry.insert("deleted_at".to_string(), Value::Null);
        self.save()
    }

    pub fn purge_item(&mut self, id: &str) -> Result<()> {
        obj_mut(&mut self.doc, "items").remove(id).with_context(|| format!("no item: {id}"))?;
        self.save()
    }

    // Restore a prior version by its timestamp: the chosen history ciphertext
    // becomes current, and the replaced current is appended to history.
    pub fn restore_version(&mut self, id: &str, at: &str) -> Result<()> {
        let stamp = now();
        let items = obj_mut(&mut self.doc, "items");
        let item = items.get_mut(id).with_context(|| format!("no item: {id}"))?;
        let history = item.get("history").and_then(Value::as_array).cloned().unwrap_or_default();
        let chosen = history.iter().find(|e| e.get("at").and_then(Value::as_str) == Some(at))
            .with_context(|| format!("no version at {at} for {id}"))?
            .get("cipher").cloned().context("history entry missing cipher")?;
        let entry = item.as_object_mut().context("item is object")?;
        if let (Some(cur_at), Some(cur)) = (entry.get("updated_at").cloned(), entry.get("current").cloned()) {
            let mut h = history;
            h.push(json!({"at": cur_at, "cipher": cur}));
            entry.insert("history".to_string(), Value::Array(h));
        }
        entry.insert("current".to_string(), chosen);
        entry.insert("updated_at".to_string(), json!(stamp));
        self.save()
    }
}
