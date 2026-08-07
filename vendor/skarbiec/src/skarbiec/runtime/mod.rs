// Runtime layer: tamper-evident audit log, credential resolution + reference
// expansion, and one-time-code / breach health helpers. Each submodule matches
// its own commands and returns None otherwise; a real error propagates via `?`.

pub mod audit;
pub mod resolve;
pub mod totp;
pub mod breach;

use anyhow::Result;
use serde_json::Value;
use std::collections::HashMap;

pub fn dispatch(command: &str, flags: &HashMap<String, String>, positionals: &[String]) -> Result<Option<Value>> {
    if let Some(v) = audit::dispatch(command, flags, positionals)? {
        return Ok(Some(v));
    }
    if let Some(v) = resolve::dispatch(command, flags, positionals)? {
        return Ok(Some(v));
    }
    if let Some(v) = totp::dispatch(command, flags, positionals)? {
        return Ok(Some(v));
    }
    if let Some(v) = breach::dispatch(command, flags, positionals)? {
        return Ok(Some(v));
    }
    Ok(None)
}
