use anyhow::{bail, Context, Result};
use chrono::Utc;
use rand::RngCore;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{IsTerminal, Read, Write};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use zeroize::{Zeroize, Zeroizing};

use crate::core::vault::Vault;
use crate::runtime::audit;

const REQUEST_WIRE_VERSION: &str = "skarbiec.credential-request.v1";
const ACQUIRE_COMMAND_ENV: &str = "SKARBIEC_WELES_ACQUIRE_COMMAND";
const RETURN_COMMAND_ENV: &str = "SKARBIEC_CREDENTIAL_RETURN_COMMAND";
const MAX_SECRET_BYTES: u64 = 16 * 1024;
const MAX_RESPONSE_BYTES: usize = 64 * 1024;

fn required_flag<'a>(flags: &'a HashMap<String, String>, name: &str) -> Result<&'a str> {
    flags
        .get(name)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .with_context(|| format!("missing --{name}"))
}

fn validate_credential_id(value: &str) -> Result<()> {
    if value.len() < 3
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
    {
        bail!("credential id must be 3-128 uppercase ASCII letters, digits, or underscores");
    }
    Ok(())
}

fn validate_label(name: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        bail!("{name} must contain only ASCII letters, digits, '.', '-', or '_'");
    }
    Ok(())
}

fn validate_request_id(value: &str) -> Result<()> {
    if value.len() != 64 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        bail!("request id must be 64 hexadecimal characters");
    }
    Ok(())
}

fn request_item_id(credential_id: &str) -> String {
    format!("request:credential/{credential_id}")
}

fn new_request_id() -> String {
    let mut bytes = Zeroizing::new([0_u8; 32]);
    rand::rngs::OsRng.fill_bytes(bytes.as_mut());
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn live_item_exists(vault: &Vault, id: &str) -> bool {
    vault
        .list(false)
        .iter()
        .any(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
}

fn checked_executable(path: &Path, env_name: &str) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("{env_name} must be an absolute path");
    }
    let link = fs::symlink_metadata(path)
        .with_context(|| format!("inspect {env_name} executable {}", path.display()))?;
    if link.file_type().is_symlink() || !link.file_type().is_file() {
        bail!("{env_name} must name a regular, non-symlink file");
    }
    let metadata = fs::metadata(path)?;
    if metadata.uid() != unsafe { libc::geteuid() } {
        bail!("{env_name} executable must be owned by the current user");
    }
    let mode = metadata.permissions().mode();
    if mode & 0o022 != 0 || mode & 0o100 == 0 {
        bail!("{env_name} executable must be owner-executable and not group/world-writable");
    }
    fs::canonicalize(path).with_context(|| format!("canonicalize {env_name}"))
}

fn string_field<'a>(value: &'a Value, name: &str) -> Option<&'a str> {
    value.get(name).and_then(Value::as_str).filter(|text| text.len() <= 512)
}

fn sanitized_weles_response(value: &Value) -> Result<Value> {
    let status = string_field(value, "status").context("Weles response missing status")?;
    let allowed = [
        "acquisition_queued",
        "followup_queued",
        "credential_returned",
        "needs_configuration",
        "unsupported_secret",
    ];
    if !allowed.contains(&status) {
        bail!("Weles returned unsupported status");
    }
    Ok(json!({
        "status": status,
        "build_id": string_field(value, "buildId"),
        "action_log_id": string_field(value, "actionLogId"),
        "message": string_field(value, "message"),
    }))
}

fn run_weles(request: &Value) -> Result<Value> {
    let configured = std::env::var(ACQUIRE_COMMAND_ENV).context(format!("{ACQUIRE_COMMAND_ENV} is not set"))?;
    let executable = checked_executable(Path::new(&configured), ACQUIRE_COMMAND_ENV)?;
    let return_executable = std::env::current_exe().context("resolve Skarbiec executable")?;
    let mut child = Command::new(executable)
        .env(RETURN_COMMAND_ENV, return_executable)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .context("start Weles credential acquisition bridge")?;
    child
        .stdin
        .take()
        .context("open Weles bridge stdin")?
        .write_all(&serde_json::to_vec(request)?)?;
    let output = child.wait_with_output().context("wait for Weles credential acquisition bridge")?;
    if !output.status.success() {
        bail!("Weles credential acquisition bridge failed");
    }
    if output.stdout.len() > MAX_RESPONSE_BYTES {
        bail!("Weles credential acquisition response exceeded size limit");
    }
    let response: Value = serde_json::from_slice(&output.stdout).context("Weles response is not JSON")?;
    sanitized_weles_response(&response)
}

fn update_request(vault_path: &Path, request_item: &str, request: &Value, status: &str, response: Option<&Value>) -> Result<()> {
    let mut updated = request.clone();
    let object = updated.as_object_mut().context("credential request is not an object")?;
    object.insert("status".to_string(), Value::String(status.to_string()));
    object.insert("updated_at".to_string(), Value::String(Utc::now().to_rfc3339()));
    if let Some(response) = response {
        object.insert("weles".to_string(), response.clone());
    }
    Vault::open(vault_path.to_path_buf())?.set_item(
        request_item,
        "credential_request",
        &updated,
        &[],
        &["credential-request".to_string()],
    )
}

fn cmd_request(vault_path: &Path, flags: &HashMap<String, String>, positionals: &[String]) -> Result<Value> {
    let credential_id = positionals
        .first()
        .map(String::as_str)
        .context("usage: credential-request <CREDENTIAL_ID> --provider <provider> --consumer <consumer> [--purpose <purpose>]")?;
    validate_credential_id(credential_id)?;
    let provider = required_flag(flags, "provider")?;
    let consumer = required_flag(flags, "consumer")?;
    validate_label("provider", provider)?;
    validate_label("consumer", consumer)?;
    let purpose = flags.get("purpose").map(String::as_str).unwrap_or(consumer);
    if purpose.is_empty() || purpose.len() > 512 || purpose.chars().any(char::is_control) {
        bail!("purpose must be 1-512 printable characters");
    }

    let mut vault = Vault::open(vault_path.to_path_buf())?;
    if live_item_exists(&vault, credential_id) {
        return Ok(json!({"ok": true, "status": "ready", "credential": credential_id}));
    }

    let request_item = request_item_id(credential_id);
    if let Ok(existing) = vault.get_item(&request_item) {
        if existing.get("status").and_then(Value::as_str) == Some("pending") {
            return Ok(json!({
                "ok": true,
                "status": "pending",
                "credential": credential_id,
                "request_id": existing.get("request_id").and_then(Value::as_str),
                "weles": existing.get("weles"),
            }));
        }
    }

    let request_id = new_request_id();
    let request = json!({
        "version": REQUEST_WIRE_VERSION,
        "request_id": request_id,
        "credential_id": credential_id,
        "provider": provider,
        "consumer": consumer,
        "purpose": purpose,
        "status": "pending",
        "created_at": Utc::now().to_rfc3339(),
    });
    vault.set_item(
        &request_item,
        "credential_request",
        &request,
        &[],
        &["credential-request".to_string(), provider.to_string()],
    )?;
    drop(vault);
    audit::append(
        "credential-request",
        &json!({"request_id": request_id, "credential": credential_id, "provider": provider, "consumer": consumer}),
    )?;

    let response = match run_weles(&request) {
        Ok(response) => response,
        Err(error) => {
            let failure = json!({"status": "failed"});
            update_request(vault_path, &request_item, &request, "failed", Some(&failure))?;
            return Err(error);
        }
    };
    let status = response.get("status").and_then(Value::as_str).unwrap_or("failed");
    if status == "credential_returned" {
        let vault = Vault::open(vault_path.to_path_buf())?;
        if !live_item_exists(&vault, credential_id) {
            bail!("Weles reported credential_returned but the credential is absent");
        }
        return Ok(json!({"ok": true, "status": "ready", "credential": credential_id, "request_id": request_id}));
    }
    if matches!(status, "acquisition_queued" | "followup_queued") {
        update_request(vault_path, &request_item, &request, "pending", Some(&response))?;
        return Ok(json!({
            "ok": true,
            "status": "pending",
            "credential": credential_id,
            "request_id": request_id,
            "weles": response,
        }));
    }
    update_request(vault_path, &request_item, &request, "failed", Some(&response))?;
    bail!("Weles could not queue credential acquisition")
}

fn read_secret_from_stdin() -> Result<Zeroizing<String>> {
    if std::io::stdin().is_terminal() {
        bail!("credential-return requires a pipe on stdin");
    }
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(MAX_SECRET_BYTES + 1)
        .read_to_end(&mut bytes)
        .context("read credential from stdin")?;
    if bytes.len() as u64 > MAX_SECRET_BYTES {
        bytes.zeroize();
        bail!("credential exceeds 16384-byte limit");
    }
    let secret = Zeroizing::new(String::from_utf8(bytes).context("credential must be UTF-8")?);
    if secret.is_empty() || secret.chars().any(|character| character == '\0') {
        bail!("credential must be non-empty and contain no NUL bytes");
    }
    Ok(secret)
}

fn cmd_return(vault_path: &Path, flags: &HashMap<String, String>, positionals: &[String]) -> Result<Value> {
    let credential_id = positionals
        .first()
        .map(String::as_str)
        .context("usage: credential-return <CREDENTIAL_ID> --request-id <id> --provider <provider>")?;
    validate_credential_id(credential_id)?;
    let request_id = required_flag(flags, "request-id")?;
    validate_request_id(request_id)?;
    let provider = required_flag(flags, "provider")?;
    validate_label("provider", provider)?;

    let request_item = request_item_id(credential_id);
    let mut vault = Vault::open(vault_path.to_path_buf())?;
    let secret = read_secret_from_stdin()?;
    if let Ok(existing) = vault.get_item(credential_id) {
        if existing.get("request_id").and_then(Value::as_str) == Some(request_id)
            && existing.get("provider").and_then(Value::as_str) == Some(provider)
            && existing.get("value").and_then(Value::as_str) == Some(secret.as_str())
        {
            return Ok(json!({"ok": true, "status": "ready", "credential": credential_id, "request_id": request_id}));
        }
    }
    let request = vault.get_item(&request_item)?;
    if request.get("version").and_then(Value::as_str) != Some(REQUEST_WIRE_VERSION)
        || request.get("status").and_then(Value::as_str) != Some("pending")
        || request.get("request_id").and_then(Value::as_str) != Some(request_id)
        || request.get("credential_id").and_then(Value::as_str) != Some(credential_id)
        || request.get("provider").and_then(Value::as_str) != Some(provider)
    {
        bail!("credential return does not match a pending request");
    }

    let item = json!({
        "type": "api_key",
        "value": secret.as_str(),
        "provider": provider,
        "source": "weles_credential_acquisition",
        "request_id": request_id,
        "acquired_at": Utc::now().to_rfc3339(),
    });
    vault.set_item(
        credential_id,
        "api_key",
        &item,
        &[],
        &["credential".to_string(), provider.to_string()],
    )?;
    vault.delete_item(&request_item)?;
    audit::append(
        "credential-return",
        &json!({"request_id": request_id, "credential": credential_id, "provider": provider}),
    )?;
    Ok(json!({"ok": true, "status": "ready", "credential": credential_id, "request_id": request_id}))
}

pub fn dispatch(
    vault_path: &Path,
    command: &str,
    flags: &HashMap<String, String>,
    positionals: &[String],
) -> Result<Option<Value>> {
    match command {
        "credential-request" => cmd_request(vault_path, flags, positionals).map(Some),
        "credential-return" => cmd_return(vault_path, flags, positionals).map(Some),
        _ => Ok(None),
    }
}
