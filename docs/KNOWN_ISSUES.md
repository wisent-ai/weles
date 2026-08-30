# Known Issues and Operational Notes

## Production Launcher Running Pre-Deletion Version

**Date discovered:** 2026-08-30

**Issue:** The Weles worker launcher on `charless-mac-mini` (`/Users/charles/weles/scripts/worker/deploy/launch-mac.sh`) is the version deleted from the repository in commit `f792637b` ("Remove database-polled Weles worker", 2026-08-24) and still exists only in worktrees and `.wisent-output` archives.

**Status:** The launcher is still the active executable for the host's launchd units (`com.wisent.always-on.weles`, `com.wisent.weles-worker`, `com.wisent.weles-content-worker`), and it continues to invoke Skarbiec credential acquisition in the pre-migration **5-argument form**:

```
skarbiec-acquire.mjs <endpoint> <scope-file> <consumer> <item> <field>
```

**Mitigation:** Dual-shape argument parsing (commit `151aab7d`, merged in PR #57) now tolerates both the old 5-argument form (with explicit endpoint positional) and the new 4-argument form (endpoint resolved internally). The positional endpoint is treated as an authoritative override with the same semantics as an explicit environment variable override.

**Next step:** When the host's launcher is updated to a current version, it will use the new 4-argument form automatically. The dual-shape parsing ensures no downtime during that transition.

---

## Launch-mac.sh Gate Accepts Only One Release Source, but Host Supplies the Other

**Date discovered:** 2026-08-30

**Issue:** Line 301 of the launcher (`launch-mac.sh`) enforces a gate that requires `STADO_RELEASE_API_URL`:

```bash
|| [ -z "${STADO_RELEASE_API_URL:-}" ] \
```

**However:**

1. The host's `weles-release-cutover` service (unit `com.wisent.compute.service.weles-release-cutover`) runs a loop that rewrites `$HOME/.config/weles/worker.env` every tick using:
   ```bash
   sed -E '/^(WC_SKARBIEC_URL|STADO_RELEASE_API_URL|...|WELES_FIREFOX_RELEASE_SHA256)=/d'
   ```
   This actively **deletes** `STADO_RELEASE_API_URL` from the environment file.

2. The same sed command then re-appends:
   ```
   STADO_RELEASE_LOCAL_ROOT=$HOME/.stado/releases
   ```
   (plus six release version/checksum coordinates)

3. The host is configured for **local release root** mode, not API URL mode.

4. The browser downloaders (`scripts/chromium/download.sh` and `scripts/firefox/download.sh`) already accept **either** source and prefer the local root:
   ```bash
   if [[ -z "${STADO_RELEASE_LOCAL_ROOT:-}" ]]; then
     require STADO_RELEASE_API_URL
   fi
   ```

**Impact:** The launcher's gate on line 301 is inconsistent with:
- The host's declared configuration (local release root via cutover service)
- The downstream downloaders it gates for (both sources acceptable)
- The reconciler's intent (delete the API URL every tick)

**Current blocker:** `com.wisent.always-on.weles` and `com.wisent.weles-api` are crash-looping because they fail this gate even though `STADO_RELEASE_LOCAL_ROOT` is set and usable. The Skarbiec 8785 fault and its acquisitions are resolved; the gate is the remaining blocker.

**Fix required:** Update launcher line 301 to accept either source, matching the downloaders:

```bash
|| ([ -z "${STADO_RELEASE_API_URL:-}" ] && [ -z "${STADO_RELEASE_LOCAL_ROOT:-}" ]) \
```

**Note:** `weles-release-cutover` itself is checked into neither `weles` nor `stado-rs` and exists only as an operator-installed script on the host. Stado-side `reconcile` cannot add `STADO_RELEASE_API_URL` because the cutover service deletes it every tick. The fix must be in the launcher gate.

---

## Endpoint Resolution with Liveness Detection

**Date:** Implemented 2026-08-30, merged PR #57 to main.

**Feature:** `skarbiec-acquire.mjs` now supports dual-shape argument parsing to tolerate version skew:

- **Legacy 5-argument:** `<endpoint> <scope-file> <consumer> <item> <field>` (endpoint auto-detected as http/https URL)
- **New 4-argument:** `<scope-file> <consumer> <item> <field>` (endpoint resolved internally)

Both paths treat explicit endpoints authoritatively — if set and not listening, fail loudly with the exact endpoint and source, never silently redirect.

Resolution order (new form):
1. Explicit env var (`WC_SKARBIEC_URL` / `WELES_CREDENTIAL_SKARBIEC_URL`) — must work or fail
2. Forward markers from `~/.stado/forwards/` — prefer listening one
3. Built-in default `http://127.0.0.1:8895` — fallback

This ensures the host's old launcher (still running 5-arg form) works correctly with released artifacts (0.5.21+) without downtime.
