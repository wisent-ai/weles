"""Extract cookies from Chrome profiles on macOS.

Reads the encrypted Cookies SQLite database from a Chrome profile,
decrypts values using the Chrome Safe Storage key from macOS Keychain,
and returns cookies ready for injection into a browser context.

Usage:
    from weles.session.chrome import extract_cookies

    cookies = extract_cookies(domain="oxylabs.io")
    await context.add_cookies(cookies)
"""

import platform
import sqlite3
import subprocess
from pathlib import Path
from typing import List, Dict, Optional


def _chrome_profiles_dir() -> Path:
    """Return the Chrome user data directory for the current platform."""
    if platform.system() == "Darwin":
        return Path.home() / "Library" / "Application Support" / "Google" / "Chrome"
    elif platform.system() == "Linux":
        return Path.home() / ".config" / "google-chrome"
    return Path.home() / "AppData" / "Local" / "Google" / "Chrome" / "User Data"


def _get_encryption_key() -> bytes:
    """Get Chrome cookie encryption key from macOS Keychain."""
    if platform.system() != "Darwin":
        return b""
    raw = subprocess.check_output([
        "security", "find-generic-password", "-w",
        "-s", "Chrome Safe Storage", "-a", "Chrome",
    ]).decode().strip()
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    from cryptography.hazmat.primitives import hashes
    kdf = PBKDF2HMAC(algorithm=hashes.SHA1(), length=16,
                      salt=b"saltysalt", iterations=1003)
    return kdf.derive(raw.encode())


def _decrypt_value(encrypted: bytes, key: bytes) -> str:
    """Decrypt a Chrome v10 encrypted cookie value."""
    if not encrypted or encrypted[:3] != b"v10" or not key:
        return ""
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives import padding
    iv = b"\x20" * 16
    cipher = Cipher(algorithms.AES128(key), modes.CBC(iv))
    dec = cipher.decryptor()
    padded = dec.update(encrypted[3:]) + dec.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    data = unpadder.update(padded) + unpadder.finalize()
    return data[32:].decode("utf-8", errors="replace")


def list_profiles() -> List[Dict[str, str]]:
    """List available Chrome profiles with their display names."""
    chrome_dir = _chrome_profiles_dir()
    if not chrome_dir.exists():
        return []
    profiles = []
    for d in sorted(chrome_dir.iterdir()):
        prefs = d / "Preferences"
        if prefs.exists():
            import json
            try:
                data = json.loads(prefs.read_text())
                name = data.get("profile", {}).get("name", d.name)
                profiles.append({"dir": d.name, "name": name, "path": str(d)})
            except (json.JSONDecodeError, KeyError):
                profiles.append({"dir": d.name, "name": d.name, "path": str(d)})
    return profiles


def extract_cookies(
    domain: str,
    profile: Optional[str] = None,
) -> List[Dict]:
    """Extract cookies for a domain from a Chrome profile.

    Args:
        domain: Domain to match (e.g. "google.com", "oxylabs.io").
            Matches host_key containing this string.
        profile: Chrome profile directory name (e.g. "Default", "Profile 1").
            If None, uses "Default".

    Returns:
        List of cookie dicts ready for context.add_cookies().
    """
    chrome_dir = _chrome_profiles_dir()
    profile_dir = profile or "Default"
    db_path = chrome_dir / profile_dir / "Cookies"

    if not db_path.exists():
        return []

    key = _get_encryption_key()
    conn = sqlite3.connect(f"file:{db_path}?mode=ro&nolock=1", uri=True)
    rows = conn.execute(
        "SELECT name, encrypted_value, host_key, path, is_secure, is_httponly "
        "FROM cookies WHERE host_key LIKE ?",
        (f"%{domain}%",),
    ).fetchall()
    conn.close()

    cookies = []
    for name, enc, host, path, secure, httponly in rows:
        try:
            value = _decrypt_value(enc, key)
            if value:
                cookies.append({
                    "name": name,
                    "value": value,
                    "domain": host,
                    "path": path,
                    "secure": bool(secure),
                    "httpOnly": bool(httponly),
                    "sameSite": "Lax",
                })
        except Exception:
            continue
    return cookies


def extract_google_cookies(profile: Optional[str] = None) -> List[Dict]:
    """Extract Google auth cookies (accounts.google.com + google.com)."""
    cookies = extract_cookies("google.com", profile=profile)
    cookies += extract_cookies("accounts.google.com", profile=profile)
    # Deduplicate by name+domain
    seen = set()
    unique = []
    for c in cookies:
        key = (c["name"], c["domain"])
        if key not in seen:
            seen.add(key)
            unique.append(c)
    return unique
