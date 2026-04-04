"""Mitmproxy addon script for traffic fingerprint capture.

Justification: This standalone script is loaded by mitmdump via ``-s addon.py``.
It hooks into TLS client-hello, HTTP request, and HTTP response events to
capture the full network fingerprint (TLS extensions, header ordering,
HTTP/2 settings, cookies, timing) and writes everything to a JSON file.

Usage:
    WELES_CAPTURE_PATH=/tmp/capture.json mitmdump -s addon.py --listen-port 8080

Note: This file is a standalone mitmproxy addon, not a regular importable
module. Constants are duplicated from config.py because mitmdump runs this
in its own interpreter and cannot import from the weles package.
"""

import hashlib
import json
import os
import time

# ---------------------------------------------------------------------------
# Addon-local settings (duplicated from config.py — see module docstring)
# These use lowercase names because this is a standalone addon, not a config
# module, and they are internal to this script.
# ---------------------------------------------------------------------------

_capture_path_env = "WELES_CAPTURE_PATH"
_max_flows = 5000
_max_header_len = 2000
_max_cookie_len = 1000

# ---------------------------------------------------------------------------
# Data store — populated by hooks, flushed on shutdown
# ---------------------------------------------------------------------------

_data = {
    "tls": [],
    "http2_settings": [],
    "requests": [],
    "responses": [],
    "cookies_sent": [],
    "cookies_received": [],
    "timing": [],
    "meta": {
        "start_time": time.time(),
        "end_time": None,
    },
}

_flow_count = 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_capture_path():
    return os.environ.get(_capture_path_env, "/tmp/weles_capture.json")


def _truncate(value, limit):
    if len(value) > limit:
        return value[:limit] + "...[truncated]"
    return value


def _compute_ja3_hash(extensions_list, cipher_suites, tls_version):
    """Compute a simplified JA3 hash from available client-hello data."""
    parts = [
        str(tls_version),
        "-".join(str(c) for c in cipher_suites),
        "-".join(str(e) for e in extensions_list),
    ]
    raw = ",".join(parts)
    return hashlib.md5(raw.encode()).hexdigest()


def _parse_cookies_from_header(cookie_header):
    """Parse a Cookie request header into name/value pairs."""
    cookies = []
    for part in cookie_header.split(";"):
        part = part.strip()
        if "=" in part:
            name, _, value = part.partition("=")
            cookies.append({
                "name": name.strip(),
                "value": _truncate(value.strip(), _max_cookie_len),
            })
    return cookies


def _parse_set_cookie(set_cookie_header):
    """Parse a Set-Cookie response header into structured data."""
    parts = set_cookie_header.split(";")
    main = parts[0].strip()
    name, _, value = main.partition("=")
    attrs = {}
    for attr in parts[1:]:
        attr = attr.strip()
        if "=" in attr:
            k, _, v = attr.partition("=")
            attrs[k.strip().lower()] = v.strip()
        elif attr:
            attrs[attr.lower()] = True
    return {
        "name": name.strip(),
        "value": _truncate(value.strip(), _max_cookie_len),
        "attributes": attrs,
    }


def _decode_field(raw):
    """Decode a header field from bytes if needed."""
    if isinstance(raw, bytes):
        return raw.decode("utf-8", errors="replace")
    return raw


def _flush():
    """Write accumulated data to the JSON file."""
    _data["meta"]["end_time"] = time.time()
    path = _get_capture_path()
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w") as f:
        json.dump(_data, f, indent=2, default=str)


# ---------------------------------------------------------------------------
# Mitmproxy event hooks
# ---------------------------------------------------------------------------

def tls_clienthello(data):
    """Capture TLS client hello fingerprint data."""
    global _flow_count
    if _flow_count >= _max_flows:
        return

    ch = data.client_hello
    entry = {"timestamp": time.time(), "sni": ch.sni}

    cipher_suites = []
    if hasattr(ch, "cipher_suites"):
        cipher_suites = list(ch.cipher_suites)
        entry["cipher_suites"] = cipher_suites

    extensions = []
    extensions_list = []
    if hasattr(ch, "extensions"):
        for ext in ch.extensions:
            ext_type = ext.type if hasattr(ext, "type") else None
            ext_data_preview = None
            if hasattr(ext, "data"):
                raw = ext.data
                if isinstance(raw, (bytes, bytearray)):
                    ext_data_preview = raw[:64].hex()
                elif isinstance(raw, str):
                    ext_data_preview = raw[:64]
            extensions.append({"type": ext_type, "data_preview": ext_data_preview})
            if ext_type is not None:
                extensions_list.append(ext_type)
        entry["extensions"] = extensions

    if hasattr(ch, "alpn_protocols"):
        entry["alpn_protocols"] = list(ch.alpn_protocols)

    tls_version = getattr(ch, "record_version", 0)
    entry["ja3_hash"] = _compute_ja3_hash(extensions_list, cipher_suites, tls_version)
    entry["ja3_raw_parts"] = {
        "tls_version": tls_version,
        "cipher_suites": cipher_suites,
        "extensions": extensions_list,
    }
    _data["tls"].append(entry)


def request(flow):
    """Capture outgoing request details."""
    global _flow_count
    if _flow_count >= _max_flows:
        return
    _flow_count += 1

    req = flow.request
    ts = time.time()

    headers_ordered = []
    for name, value in req.headers.fields:
        h_name = _decode_field(name)
        h_value = _decode_field(value)
        headers_ordered.append({
            "name": h_name,
            "value": _truncate(h_value, _max_header_len),
        })

    entry = {
        "timestamp": ts,
        "method": req.method,
        "url": req.pretty_url,
        "http_version": req.http_version,
        "headers": headers_ordered,
        "header_names_order": [h["name"] for h in headers_ordered],
        "content_type": req.headers.get("content-type"),
        "content_length": req.headers.get("content-length"),
    }

    if hasattr(flow, "client_conn") and flow.client_conn:
        cc = flow.client_conn
        if hasattr(cc, "alpn") and cc.alpn:
            alpn_val = cc.alpn
            if isinstance(alpn_val, bytes):
                alpn_val = alpn_val.decode("utf-8", errors="replace")
            entry["negotiated_protocol"] = alpn_val

    if req.http_version == "HTTP/2.0":
        pseudo_headers = [h["name"] for h in headers_ordered if h["name"].startswith(":")]
        _data["http2_settings"].append({
            "timestamp": ts,
            "url": req.pretty_url,
            "info": {"protocol": "h2", "pseudo_header_order": pseudo_headers},
        })

    cookie_header = req.headers.get("cookie")
    if cookie_header:
        cookies = _parse_cookies_from_header(cookie_header)
        if cookies:
            _data["cookies_sent"].append({
                "timestamp": ts, "url": req.pretty_url, "cookies": cookies,
            })

    _data["requests"].append(entry)
    _data["timing"].append({
        "timestamp": ts, "type": "request",
        "method": req.method, "url": req.pretty_url,
    })


def response(flow):
    """Capture incoming response details."""
    resp = flow.response
    req = flow.request
    ts = time.time()

    headers_ordered = []
    for name, value in resp.headers.fields:
        headers_ordered.append({
            "name": _decode_field(name),
            "value": _truncate(_decode_field(value), _max_header_len),
        })

    _data["responses"].append({
        "timestamp": ts,
        "url": req.pretty_url,
        "status_code": resp.status_code,
        "http_version": resp.http_version,
        "headers": headers_ordered,
        "header_names_order": [h["name"] for h in headers_ordered],
        "content_type": resp.headers.get("content-type"),
        "content_length": resp.headers.get("content-length"),
    })

    for name, value in resp.headers.fields:
        h_name = _decode_field(name)
        if h_name.lower() == "set-cookie":
            h_value = _decode_field(value)
            _data["cookies_received"].append({
                "timestamp": ts,
                "url": req.pretty_url,
                "cookie": _parse_set_cookie(h_value),
            })

    _data["timing"].append({
        "timestamp": ts, "type": "response",
        "status_code": resp.status_code, "url": req.pretty_url,
    })


def done():
    """Called when mitmdump is shutting down — flush captured data."""
    _flush()
