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

## 5. Stado's Declared Service Runtime Owns `$HOME/weles`, So auto-deploy Cannot Hold an Activation

**Status:** Root cause of #4, measured 2026-08-31 with a repaired installer in hand.

**Issue:** `auto-deploy.sh` activates a release by pointing `$HOME/weles` at the
unpacked tree. On charless-mac-mini that link is also owned by Stado's service
management, which reconciles it to the release declared for
`com.wisent.always-on.weles-api`. The two write the same path and the declared
state wins, correctly.

**Evidence:** `stado host activate-staged-release` ran 0.5.43's own installer
from the staged archive. The installer completed and logged
`deploy ok: activated immutable stado://releases/weles-worker/0.5.43/darwin-arm64/weles-worker.tar.gz`,
and the link read
`/Users/charles/.local/share/weles-worker/0.5.43/darwin-arm64` immediately
afterwards. Thirty seconds later the same link read
`/Users/charles/.stado/services/com.wisent.always-on.weles-api/sha256-87ced1c9d349/darwin-arm/runtime`.
The release stays installed and staged; only the runtime link is taken back.

**Consequence:** every weles-side delivery mechanism on this host is advisory.
A release reaches the machine, verifies, unpacks and activates, and is then
reverted within a cycle. That is why 0.5.32, 0.5.41, 0.5.42 and 0.5.43 all sat
installed while the running tree stayed where Stado's declaration put it.

**What this needs:** the declared release for `com.wisent.always-on.weles-api`
has to move, rather than the symlink. `stado service release` refuses today —
weles-worker is absent from `registry.release_control`, and `stado host release`
wants a canonical per-platform manifest no weles version has ever published.
Authoring that policy is a deployment decision (strategy, ports, readiness path,
install root, run-as user), not a repair, so it is written down here rather than
invented.

## 4. No Adoption Path Delivers a Published Worker Release to charless-mac-mini

**Status:** Open. Measured 2026-08-31 with a published release in hand.

**Issue:** Worker 0.5.32 was built and published through the product's own path
— `release submit` completed (built on charless-mac-mini, artifact
`faea9c0a64a6a88756c3a154d771f215ed6efbdedb9b22d0c84c4873121a93a7`) and the
`worker-v0.5.32` tag drove `release-worker.yml` to success on both platforms,
publishing https://github.com/wisent-ai/weles/releases/tag/worker-v0.5.32.
The host did not adopt it. `stado host weles-activity charless-mac-mini` still
reports `worker 0.5.21 staged, 0.5.21 newest installed`, and the release's own
`scripts/worker/deploy/weles-capability-routes.json` on that host still carries
the four pre-0.5.32 routes.

**Every Stado adoption verb refuses, each for its own structural reason:**

| Verb | Refusal |
|---|---|
| `host release --binary weles-worker --version <v>` | `canonical release manifest is unavailable at stado://releases/weles-worker/<v>/darwin-arm64/release-manifest-darwin-arm64.json` — HTTP 404. Absent for **every** version tried: 0.5.24 (the version the registry declares for this host), 0.5.31 and 0.5.32. This delivery path has never been populated for this product. |
| `host promote-version` | Same coordinate check, same absence. |
| `service release --product weles-worker` | `com.wisent.weles-worker runs "/Users/charles/weles/scripts/worker/deploy/launch-mac.sh", which is not under a managed services directory`. Also `--product` must appear in `registry.release_control`, and only `brama`, `image-video-router` and `skarbiec` do. |
| the product's own unit | `com.wisent.weles-auto-deploy` — see below. |

**The product's own adoption unit exists but is neither loaded nor declared.**
Its plist is installed at
`/Users/charles/Library/LaunchAgents/com.wisent.weles-auto-deploy.plist`
(`ProgramArguments` → `/Users/charles/weles/scripts/worker/deploy/auto-deploy.sh`,
`RunAtLoad`, `StartInterval 60`, logging to `~/weles/var/auto-deploy.log`, which
is ~10 MB, so it has run extensively in the past). It does not appear in
`launchctl list` for that login, and `stado host link charless-mac-mini` confirms
the domain exists to load it in (`charles owns /dev/console and launchd has
gui/501`). It is **not** among the 18 services the registry declares for this
host, so it is undeclared rather than drifted: reconciling it with
`stado service ensure` would be inventing a declaration, not restoring one.

**Consequence for the capability route table.** The active broker table
`~/.stado/weles-api-capability-routes.json` follows the *installed release*.
Delivering the corrected 6-route file with `stado service file-sync` to either
`~/.stado/files/weles-capability-routes.json` (the staged copy that
`configure-weles-capability-host.mjs` applies) or directly to the active path is
reported `file_synced` and is then restored to the release's 4-route content
within ~20 seconds, measured four times. So the released payload really is the
only durable carrier of a route, and a host that cannot adopt a release cannot
gain one.

**Service state is currently unobservable on this host.** `stado service status`
answers `unknown` for every unit with `health beacon is 394220s old`, and
`stado host link` returns `verdict: degraded` with a silence open since
2026-08-25T17:08:17Z whose first reader error is
`registry store unreachable (stado:registry.json): Stado object API error HTTP 503: {"error":"object authorization unavailable"}`.
SSH answers. So "not running" cannot be concluded for the system-domain daemons
from here — a non-root `launchctl list` over the channel sees only the caller's
domain, which is why that reading is valid for the user-domain auto-deploy agent
and not for `/Library/LaunchDaemons` units.

**Deliberately not done:** authoring a `registry.release_control` policy for
`weles-worker`. That means declaring blue-green strategy, ports, readiness path,
install root and run-as-user for a product other machinery deploys, which is a
deployment decision rather than a repair.

**Smallest next step:** decide whether `com.wisent.weles-auto-deploy` should be
a registry-declared service for this host. If it should, declaring it makes
`stado service ensure` the sanctioned, idempotent way to keep it loaded, and
adoption of 0.5.32 follows on its own 60-second interval.

---

## Reference: Script Text Recovery

**Note:** The weles-release-cutover environment configuration was read from the host using `stado service env-show`, which sanitizes `"` and `\` to `?` for display purposes. The output is faithful enough for operational reasoning but **NOT byte-exact**. Do not paste it into a repository as a recovered source file. Any effort to bring these unversioned scripts under version control must obtain a real copy from the host, not a transcribed/reconstructed version.
