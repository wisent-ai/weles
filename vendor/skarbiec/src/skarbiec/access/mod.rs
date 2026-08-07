// Access + sharing layer: cryptographic per-recipient sharing, consumer service
// tokens with scopes, recovery / emergency access, and admin policy. Each
// submodule matches its own commands and returns None for anything else, so
// this router simply forwards to them in turn; a real error propagates via `?`.

pub mod recipients;
pub mod tokens;
pub mod recovery;
pub mod policy;

use anyhow::Result;
use serde_json::Value;
use std::collections::HashMap;

pub fn dispatch(command: &str, flags: &HashMap<String, String>, positionals: &[String]) -> Result<Option<Value>> {
    if let Some(v) = recipients::dispatch(command, flags, positionals)? {
        return Ok(Some(v));
    }
    if let Some(v) = tokens::dispatch(command, flags, positionals)? {
        return Ok(Some(v));
    }
    if let Some(v) = recovery::dispatch(command, flags, positionals)? {
        return Ok(Some(v));
    }
    if let Some(v) = policy::dispatch(command, flags, positionals)? {
        return Ok(Some(v));
    }
    Ok(None)
}
