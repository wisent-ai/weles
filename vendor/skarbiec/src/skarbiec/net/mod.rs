// Network layer: git-backed multi-device sync of the encrypted vault, and a
// local HTTP API the separate client products (browser extension, desktop and
// mobile apps, admin console) integrate against. Each submodule matches its own
// commands and returns None otherwise; a real error propagates via `?`.

pub mod sync;
pub mod http;

use anyhow::Result;
use serde_json::Value;
use std::collections::HashMap;

pub fn dispatch(command: &str, flags: &HashMap<String, String>, positionals: &[String]) -> Result<Option<Value>> {
    if let Some(v) = sync::dispatch(command, flags, positionals)? {
        return Ok(Some(v));
    }
    if let Some(v) = http::dispatch(command, flags, positionals)? {
        return Ok(Some(v));
    }
    Ok(None)
}
