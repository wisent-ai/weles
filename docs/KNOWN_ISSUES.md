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

## 2. The Deleted Launcher Carries an Outdated Gate, But HEAD Already Corrected It

**Date discovered:** 2026-08-30

**The issue on the host:** The pre-f792637b `launch-mac.sh` on charless-mac-mini carries a strict gate requiring `STADO_RELEASE_API_URL` unconditionally, which blocks worker startup when the host runs in `STADO_RELEASE_LOCAL_ROOT` mode.

**Verification of current state:** This gate defect does NOT exist in weles HEAD. `git grep -n 'z "${STADO_RELEASE_API_URL' HEAD -- scripts/` returns nothing. The current pattern in HEAD (`scripts/worker/deploy/auto-deploy.sh` lines 74-75) correctly accepts either release source:

```bash
if [[ -z "${STADO_RELEASE_LOCAL_ROOT:-}" ]]; then
  require STADO_RELEASE_API_URL
fi
```

The strict gate exists only in:
- The pre-f792637b `launch-mac.sh` on charless-mac-mini (restored repeatedly by the crash-loop)
- Committed snapshot artifacts in `.wisent-output/work/source/scripts/worker/deploy/` (build output, not source)

**Impact:** The host cannot converge to the corrected code because `weles-release-cutover` keeps restoring the deleted launcher. This is purely a host-side issue. **No Weles repository change is required.**

**The real blocker is item 1 (the crash-loop).** Once that loop is stopped or fixed, the host will deploy the current code that already accepts either release source.

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
