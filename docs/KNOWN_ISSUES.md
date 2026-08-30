# Known Issues and Operational Notes

## 1. Release Cutover Service Crash-Loop Restoring Deleted Launcher

**Date discovered:** 2026-08-30

**Issue:** The Weles worker launcher on `charless-mac-mini` (`/Users/charles/weles/scripts/worker/deploy/launch-mac.sh`) is the version deleted from the repository in commit `f792637b` ("Remove database-polled Weles worker", 2026-08-24). It persists not due to drift, but because the release cutover service (`com.wisent.compute.service.weles-release-cutover`) is in a permanent crash-loop that restores it on every cycle.

**Root cause:** The service is configured with `RunAtLoad` and `KeepAlive: true` but has no exit condition. It reads its own `$HOME/.local/state/weles/release-cutover.complete` marker (indicating it is a **completed one-shot**) and prints "reconciling completed release cutover", then proceeds. On each cycle:

1. Re-applies the configuration stage (including an env file rewrite that deletes `STADO_RELEASE_API_URL`)
2. Attempts immutable release activation
3. **Fails** with: `ERROR: verified worker archive is missing its exact Skarbiec acquisition scope catalog`
4. Restores the pre-f792637b checkout (including deleted `launch-mac.sh`)
5. Repeats indefinitely because `KeepAlive` restarts it after each failure

**Why the launcher persists:** The deleted script is restored on every cycle. Any launcher changes deployed through the release path will be overwritten by this loop.

**Fix for the loop:** A completed one-shot script should not be under `KeepAlive`. The service definition needs to be exited from active service management so it runs once and stops.

**Possible next step (UNVERIFIED):** The stated failure is missing Skarbiec acquisition scope catalog in the verified worker archive. `stado host sync-acquisition-scopes charless-mac-mini` is described as "Deliver the checked-in Skarbiec acquisition-scope catalog to TARGET and register it against the host's fleet vault". This error message text matches, but it has not been confirmed that this command would resolve the missing catalog failure or that it targets the same catalog the release archive is verified against. This is a lead, not a diagnosis.

**Note on unversioned scripts:** Neither `weles-release-cutover` nor the `launch-mac.sh` it restores is checked into any repository (`weles` or `wisent-compute`). Production is executing two files that cannot be reviewed, diffed, or evolved through normal change control. The proper long-term fix is to bring both under version control.

---

## 2. Launcher Gate Stricter Than Downstream Consumers and Host Configuration

**Date discovered:** 2026-08-30

**Issue:** Line 301 of `scripts/worker/deploy/launch-mac.sh` enforces a gate requiring `STADO_RELEASE_API_URL` unconditionally:

```bash
|| [ -z "${STADO_RELEASE_API_URL:-}" ] \
```

**But:**

- The browser downloaders (`scripts/chromium/download.sh` and `scripts/firefox/download.sh`) that this gate exists for already accept **either** source and prefer the local root:
  ```bash
  if [[ -z "${STADO_RELEASE_LOCAL_ROOT:-}" ]]; then
    require STADO_RELEASE_API_URL
  fi
  ```

- Their header comments state: "STADO_RELEASE_LOCAL_ROOT or STADO_RELEASE_API_URL"

- The host is configured for **local release root** mode (via `weles-release-cutover` setting `STADO_RELEASE_LOCAL_ROOT=$HOME/.stado/releases` and deleting `STADO_RELEASE_API_URL` on every tick)

**Impact:** The gate is stricter than:
- The thing it gates for (downloaders accept either)
- The host's declared configuration (local root mode)
- The reconciler's intent (delete the API URL every tick)

**Current blocker:** `com.wisent.always-on.weles` and `com.wisent.weles-api` crash-loop failing this gate even though `STADO_RELEASE_LOCAL_ROOT` is set and usable. The Skarbiec 8785 fault and its acquisitions are resolved; this gate is the remaining blocker.

**Code fix required:** Update launcher line 301 to require `STADO_RELEASE_API_URL` only when `STADO_RELEASE_LOCAL_ROOT` is empty, matching the downloaders:

```bash
|| ([ -z "${STADO_RELEASE_API_URL:-}" ] && [ -z "${STADO_RELEASE_LOCAL_ROOT:-}" ]) \
```

---

## 3. Endpoint Resolution with Liveness Detection

**Date:** Implemented 2026-08-30, merged PR #57 to main.

**Feature:** `skarbiec-acquire.mjs` now supports dual-shape argument parsing to tolerate version skew:

- **Legacy 5-argument:** `<endpoint> <scope-file> <consumer> <item> <field>` (endpoint auto-detected as http/https URL)
- **New 4-argument:** `<scope-file> <consumer> <item> <field>` (endpoint resolved internally)

Both paths treat explicit endpoints authoritatively — if set and not listening, fail loudly with the exact endpoint and source, never silently redirect.

Resolution order (new form):
1. Explicit env var (`WC_SKARBIEC_URL` / `WELES_CREDENTIAL_SKARBIEC_URL`) — must work or fail
2. Forward markers from `~/.stado/forwards/` — prefer listening one
3. Built-in default `http://127.0.0.1:8895` — fallback

**Mitigation for launcher version skew:** The host's deleted launcher (still running 5-arg form) will work correctly with released artifacts (0.5.21+) through this dual-shape parsing. No downtime required during launcher update.

---

## Reference: Script Text Recovery

**Note:** The weles-release-cutover environment configuration was read from the host using `stado service env-show`, which sanitizes `"` and `\` to `?` for display purposes. The output is faithful enough for operational reasoning but **NOT byte-exact**. Do not paste it into a repository as a recovered source file. Any effort to bring these unversioned scripts under version control must obtain a real copy from the host, not a transcribed/reconstructed version.
