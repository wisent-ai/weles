// Git-backed multi-device sync. The vault file is ciphertext, so it is safe to
// commit and push to a remote and pull back on another device. A dedicated sync
// directory (a git repo) holds a copy named vault.enc.json; push copies the
// live vault into it and commits+pushes, pull fetches and copies it back.

use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Command;

use crate::core::vault_path;

fn sync_dir() -> PathBuf {
    if let Ok(d) = std::env::var("SKARBIEC_SYNC_DIR") {
        return PathBuf::from(d);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".skarbiec-sync")
}

fn mirror_path() -> PathBuf {
    sync_dir().join("vault.enc.json")
}

fn git(args: &[&str]) -> Result<(bool, String, String)> {
    let out = Command::new("git").arg("-C").arg(sync_dir()).args(args).output().context("run git")?;
    Ok((out.status.success(), String::from_utf8_lossy(&out.stdout).into_owned(), String::from_utf8_lossy(&out.stderr).into_owned()))
}

pub fn dispatch(command: &str, flags: &HashMap<String, String>, positionals: &[String]) -> Result<Option<Value>> {
    match command {
        "sync-init" => {
            let remote = positionals.first().context("usage: sync-init <remote-url>")?;
            std::fs::create_dir_all(sync_dir())?;
            let (ok, _o, e) = git(&["init"])?;
            if !ok {
                bail!("git init failed: {}", e.trim());
            }
            git(&["remote", "remove", "origin"]).ok();
            let (ok2, _o2, e2) = git(&["remote", "add", "origin", remote])?;
            if !ok2 {
                bail!("git remote add failed: {}", e2.trim());
            }
            crate::runtime::audit::append("sync-init", &json!({"remote": remote}))?;
            Ok(Some(json!({"ok": true, "sync_dir": sync_dir().display().to_string(), "remote": remote})))
        }
        "sync-push" => {
            let live = vault_path();
            if !live.exists() {
                bail!("no vault to push at {}", live.display());
            }
            std::fs::create_dir_all(sync_dir())?;
            std::fs::copy(&live, mirror_path()).context("copy vault into sync dir")?;
            git(&["add", "vault.enc.json"])?;
            let message = flags.get("message").map(String::as_str).unwrap_or("skarbiec sync");
            git(&["commit", "-m", message]).ok(); // no-op commit is fine
            let branch = flags.get("branch").map(String::as_str).unwrap_or("main");
            let (ok, _o, e) = git(&["push", "origin", branch])?;
            crate::runtime::audit::append("sync-push", &json!({"branch": branch, "ok": ok}))?;
            Ok(Some(json!({"ok": ok, "branch": branch, "detail": e.trim()})))
        }
        "sync-pull" => {
            let branch = flags.get("branch").map(String::as_str).unwrap_or("main");
            let (ok, _o, e) = git(&["pull", "--no-rebase", "origin", branch])?;
            if !ok {
                return Ok(Some(json!({"ok": false, "reason": "git_pull_failed", "detail": e.trim()})));
            }
            let mirror = mirror_path();
            if !mirror.exists() {
                bail!("sync repo has no vault.enc.json yet");
            }
            std::fs::copy(&mirror, vault_path()).context("copy synced vault into place")?;
            crate::runtime::audit::append("sync-pull", &json!({"branch": branch}))?;
            Ok(Some(json!({"ok": true, "branch": branch, "vault": vault_path().display().to_string()})))
        }
        _ => Ok(None),
    }
}
