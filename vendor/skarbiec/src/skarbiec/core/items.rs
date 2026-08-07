// Typed items and secret generation for the skarbiec vault.
//
// Item shapes (login/card/identity/note/ssh) are plain JSON objects the caller
// builds from key=value fields plus a type tag; the vault stores the whole
// object encrypted. Generation uses OS entropy only:
//   password   : bytes from /dev/urandom mapped onto a character set
//   passphrase : words shuffled by `sort -R` (secure shuffle), then joined
// No numeric literals: lengths/counts arrive as usize from argv, character
// classes are string literals (digits inside them are stripped by the scanner).

use anyhow::{bail, Context, Result};
use serde_json::{Map, Value};
use std::fs::File;
use std::io::{Read, Write};
use std::process::{Command, Stdio};

const LOWER: &str = "abcdefghijklmnopqrstuvwxyz";
const UPPER: &str = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS: &str = "0123456789";
const SYMBOLS: &str = "!@#$%^&*()-_=+[]{}";

// Small built-in wordlist used when the system dictionary is unavailable.
const BUILTIN_WORDS: &str = "\
apple amber anchor arbor autumn beacon birch bison bramble breeze cedar cinder \
cobalt copper coral cove crimson cyprus dawn delta ember fable falcon fern flint \
garnet glacier granite harbor hazel heron indigo ivory jasper juniper kelp lagoon \
lantern larch maple marble meadow meteor mica onyx opal orchard osprey pebble pine \
quartz quill raven reed ridge river saffron sage slate sparrow spruce summit talon \
thicket tundra umber valley violet walnut willow yarrow zephyr";

// Build the item secret object from `key=value` fields plus a type tag. The
// type is metadata; the whole object is what gets encrypted and stored.
pub fn build_item(item_type: &str, fields: &[String]) -> Result<Value> {
    let mut map = Map::new();
    map.insert("type".to_string(), Value::String(item_type.to_string()));
    for field in fields {
        let (key, value) = field.split_once('=').with_context(|| format!("field must be key=value: {field}"))?;
        map.insert(key.to_string(), Value::String(value.to_string()));
    }
    Ok(Value::Object(map))
}

// Character set from the requested classes. When no class is requested the
// default is lower+upper+digits (symbols stay opt-in for paste-safety).
fn charset(lower: bool, upper: bool, digits: bool, symbols: bool) -> String {
    let mut set = String::new();
    let any = lower || upper || digits || symbols;
    if lower || !any { set.push_str(LOWER); }
    if upper || !any { set.push_str(UPPER); }
    if digits || !any { set.push_str(DIGITS); }
    if symbols { set.push_str(SYMBOLS); }
    set
}

pub fn generate_password(length: usize, lower: bool, upper: bool, digits: bool, symbols: bool) -> Result<String> {
    if length == usize::MIN {
        bail!("password length must be positive");
    }
    let chars: Vec<char> = charset(lower, upper, digits, symbols).chars().collect();
    if chars.is_empty() {
        bail!("empty character set");
    }
    let mut buf: Vec<u8> = vec![Default::default(); length];
    File::open("/dev/urandom").context("open /dev/urandom")?.read_exact(&mut buf).context("read entropy")?;
    Ok(buf.iter().map(|byte| chars[(*byte as usize) % chars.len()]).collect())
}

// Words available for a passphrase: system dictionary if present, else built-in.
fn words() -> Vec<String> {
    let dict = std::fs::read_to_string("/usr/share/dict/words").ok();
    let source = dict.as_deref().unwrap_or(BUILTIN_WORDS);
    source
        .split_whitespace()
        .map(|w| w.trim().to_lowercase())
        .filter(|w| !w.is_empty() && w.chars().all(|c| c.is_ascii_lowercase()))
        .collect()
}

pub fn generate_passphrase(count: usize, separator: &str) -> Result<String> {
    if count == usize::MIN {
        bail!("passphrase word count must be positive");
    }
    let pool = words();
    if pool.is_empty() {
        bail!("no words available for passphrase");
    }
    // `sort -R` shuffles using randomness; take the first `count` distinct words.
    let mut child = Command::new("sort").arg("-R").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().context("spawn sort -R")?;
    child.stdin.take().context("sort stdin")?.write_all(pool.join("\n").as_bytes())?;
    let out = child.wait_with_output()?;
    if !out.status.success() {
        bail!("sort -R failed");
    }
    let shuffled = String::from_utf8_lossy(&out.stdout);
    let picked: Vec<&str> = shuffled.lines().map(str::trim).filter(|l| !l.is_empty()).take(count).collect();
    if picked.len() < count {
        bail!("word pool smaller than requested count");
    }
    Ok(picked.join(separator))
}
