"""Compare two traffic captures to find fingerprint differences.

Justification: Takes two capture JSONs (one from a real browser, one from an
automated browser) and produces a structured diff report showing exactly what
the automated browser does differently — TLS fingerprint, HTTP/2 settings,
header ordering, missing/extra headers, cookie differences, and request
ordering.

Usage:
    from weles.traffic import compare_captures
    diff = compare_captures("real_capture.json", "automated_capture.json")
"""

import json
from collections import Counter
from typing import Any, Dict, List, Optional, Union

from .config import (
    IGNORED_DIFF_HEADERS,
    MAX_SAMPLE_VALUES,
    REQUEST_ORDER_COMPARISON_LEN,
)


def compare_captures(
    real_path: Union[str, Dict], automated_path: Union[str, Dict],
    *, ignore_headers: Optional[set] = None,
) -> Dict[str, Any]:
    """Compare a real browser capture against an automated browser capture.

    Returns a structured diff report with sections for TLS, HTTP/2, headers,
    cookies, request ordering, and a summary.
    """
    real = _load(real_path)
    auto = _load(automated_path)
    skip = set(IGNORED_DIFF_HEADERS)
    if ignore_headers:
        skip |= {h.lower() for h in ignore_headers}
    return {
        "tls": _cmp_tls(real, auto),
        "http2": _cmp_http2(real, auto),
        "headers": _cmp_headers(real, auto, skip),
        "cookies": _cmp_cookies(real, auto),
        "request_ordering": _cmp_ordering(real, auto),
        "summary": _summary(real, auto),
    }


def _load(src: Union[str, Dict]) -> Dict:
    if isinstance(src, dict):
        return src
    with open(src) as f:
        return json.load(f)


# -- TLS --------------------------------------------------------------------

def _ja3_set(entries: List[Dict]) -> set:
    return {e.get("ja3_hash") for e in entries if e.get("ja3_hash")}


def _cmp_tls(real: Dict, auto: Dict) -> Dict[str, Any]:
    r, a = real.get("tls", []), auto.get("tls", [])
    if not r and not a:
        return {"status": "no_tls_data"}
    rh, ah = _ja3_set(r), _ja3_set(a)
    result: Dict[str, Any] = {
        "real_ja3_hashes": sorted(rh), "automated_ja3_hashes": sorted(ah),
        "match": rh == ah,
    }
    if r and a:
        rp, ap = r[0].get("ja3_raw_parts", {}), a[0].get("ja3_raw_parts", {})
        rc, ac = set(rp.get("cipher_suites", [])), set(ap.get("cipher_suites", []))
        result["cipher_suites"] = {
            "only_in_real": sorted(rc - ac), "only_in_automated": sorted(ac - rc),
            "common": sorted(rc & ac),
        }
        re, ae = set(rp.get("extensions", [])), set(ap.get("extensions", []))
        result["extensions"] = {
            "only_in_real": sorted(re - ae), "only_in_automated": sorted(ae - re),
            "common": sorted(re & ae),
        }
        reo, aeo = rp.get("extensions", []), ap.get("extensions", [])
        result["extension_order_match"] = reo == aeo
        if reo != aeo:
            result["real_extension_order"] = reo
            result["automated_extension_order"] = aeo
    ra, aa = set(), set()
    for e in r:
        ra.update(e.get("alpn_protocols", []))
    for e in a:
        aa.update(e.get("alpn_protocols", []))
    if ra or aa:
        result["alpn"] = {"real": sorted(ra), "automated": sorted(aa), "match": ra == aa}
    return result


# -- HTTP/2 -----------------------------------------------------------------

def _pseudo_orders(entries: List[Dict]) -> List[List[str]]:
    seen = []
    for e in entries:
        o = e.get("info", {}).get("pseudo_header_order", [])
        if o and o not in seen:
            seen.append(o)
    return seen


def _cmp_http2(real: Dict, auto: Dict) -> Dict[str, Any]:
    rh, ah = real.get("http2_settings", []), auto.get("http2_settings", [])
    if not rh and not ah:
        return {"status": "no_http2_data"}
    ro, ao = _pseudo_orders(rh), _pseudo_orders(ah)
    return {
        "real_pseudo_header_orders": ro, "automated_pseudo_header_orders": ao,
        "pseudo_header_order_match": ro == ao,
        "real_entry_count": len(rh), "automated_entry_count": len(ah),
    }


# -- Headers ----------------------------------------------------------------

def _header_names(reqs: List[Dict]) -> set:
    return {h["name"] for r in reqs for h in r.get("headers", [])}


def _top_order(reqs: List[Dict]) -> List[str]:
    c: Counter = Counter()
    for r in reqs:
        t = tuple(h["name"].lower() for h in r.get("headers", []))
        if t:
            c[t] += 1
    return list(c.most_common(1)[0][0]) if c else []


def _header_vals(reqs: List[Dict], skip: set) -> Dict[str, List[str]]:
    v: Dict[str, List[str]] = {}
    for r in reqs:
        for h in r.get("headers", []):
            n = h["name"].lower()
            if n not in skip:
                v.setdefault(n, []).append(h["value"])
    return v


def _cmp_headers(real: Dict, auto: Dict, skip: set) -> Dict[str, Any]:
    rr, ar = real.get("requests", []), auto.get("requests", [])
    rs = {h.lower() for h in _header_names(rr)} - skip
    ас = {h.lower() for h in _header_names(ar)} - skip
    ro, ao = _top_order(rr), _top_order(ar)
    rv, av = _header_vals(rr, skip), _header_vals(ar, skip)
    vd = []
    for n in sorted(set(rv) & set(av)):
        ru, au = set(rv[n]), set(av[n])
        if ru != au:
            vd.append({
                "header": n,
                "real_values": sorted(ru)[:MAX_SAMPLE_VALUES],
                "automated_values": sorted(au)[:MAX_SAMPLE_VALUES],
            })
    return {
        "only_in_real": sorted(rs - ас), "only_in_automated": sorted(ас - rs),
        "common": sorted(rs & ас),
        "real_typical_order": ro, "automated_typical_order": ao,
        "order_match": ro == ao, "value_differences": vd,
    }


# -- Cookies ----------------------------------------------------------------

def _cookie_sent(entries: List[Dict]) -> set:
    return {c.get("name", "") for e in entries for c in e.get("cookies", [])}


def _cookie_recv(entries: List[Dict]) -> set:
    return {e.get("cookie", {}).get("name", "") for e in entries
            if e.get("cookie", {}).get("name")}


def _cmp_cookies(real: Dict, auto: Dict) -> Dict[str, Any]:
    rs, ас = _cookie_sent(real.get("cookies_sent", [])), _cookie_sent(auto.get("cookies_sent", []))
    rr, ar = _cookie_recv(real.get("cookies_received", [])), _cookie_recv(auto.get("cookies_received", []))
    return {
        "sent": {"only_in_real": sorted(rs - ас), "only_in_automated": sorted(ас - rs),
                 "common": sorted(rs & ас)},
        "received": {"only_in_real": sorted(rr - ar), "only_in_automated": sorted(ar - rr),
                     "common": sorted(rr & ar)},
    }


# -- Request ordering -------------------------------------------------------

def _req_seq(timing: List[Dict]) -> List[str]:
    return [e.get("url", "") for e in timing if e.get("type") == "request"]


def _cmp_ordering(real: Dict, auto: Dict) -> Dict[str, Any]:
    rs, ас = _req_seq(real.get("timing", [])), _req_seq(auto.get("timing", []))
    n = min(REQUEST_ORDER_COMPARISON_LEN, len(rs), len(ас))
    rh, ah = rs[:n], ас[:n]
    m = sum(1 for r, a in zip(rh, ah) if r == a)
    return {
        "real_total_requests": len(rs), "automated_total_requests": len(ас),
        "first_n_match_ratio": m / n if n else 0, "comparison_count": n,
        "real_first_n": rh, "automated_first_n": ah,
    }


# -- Summary ----------------------------------------------------------------

def _summary(real: Dict, auto: Dict) -> Dict[str, Any]:
    issues = []
    if _ja3_set(real.get("tls", [])) != _ja3_set(auto.get("tls", [])):
        issues.append("TLS fingerprint (JA3) differs")
    r2, a2 = real.get("http2_settings", []), auto.get("http2_settings", [])
    if _pseudo_orders(r2) != _pseudo_orders(a2):
        issues.append("HTTP/2 pseudo-header ordering differs")
    rr, ar = real.get("requests", []), auto.get("requests", [])
    rl, al = {h.lower() for h in _header_names(rr)}, {h.lower() for h in _header_names(ar)}
    ign = IGNORED_DIFF_HEADERS
    missing, extra = rl - al - ign, al - rl - ign
    if missing:
        issues.append(f"Missing {len(missing)} headers that real browser sends")
    if extra:
        issues.append(f"{len(extra)} extra headers not sent by real browser")
    ro, ao = _top_order(rr), _top_order(ar)
    if ro and ao and ro != ao:
        issues.append("Request header ordering differs")
    rc = _cookie_sent(real.get("cookies_sent", []))
    ac = _cookie_sent(auto.get("cookies_sent", []))
    if rc != ac:
        issues.append("Different cookies sent")
    return {"issue_count": len(issues), "issues": issues,
            "verdict": "MATCH" if not issues else "DIFFERENCES_FOUND"}
