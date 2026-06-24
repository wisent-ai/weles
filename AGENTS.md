# Agent Notes

## When a trajectory does not work on the first run

- A trajectory is a one-shot automation script. If it fails or needs iterative debugging, do not spam the same trajectory repeatedly to "see what happens".
- Instead, use a **keeper**: a persistent Weles browser sidecar (`scripts/_shared/keeper/keeper.mjs`) that holds a live session and can be driven interactively via `scripts/_shared/keeper/action.mjs`.
- Use the keeper to walk through the problematic flow manually, identify the exact selectors / pages / consent steps / redirects, and verify the state transitions.
- Only convert the verified steps back into a trajectory once the path is known and stable.
- This avoids burning credentials, triggering rate limits, and cluttering the recordings directory with dozens of failed runs.

## LinkedIn trajectory diagnostics workflow

- Before every browser or trajectory test, clean up or explicitly verify there are no stale `linkedin_register`, Weles Chromium, Playwright Chrome for Testing, Firefox/Nightly, `playwright_chromiumdev_profile`, or `weles-fp-` processes. Stale browser state has caused misleading LinkedIn and navigation results.
- For LinkedIn register work, validate diagnostics changes with the real trajectory, not only toy navigation checks. The meaningful non-hanging result is: load signup, submit email/password, reach first/last-name form, click Continue, then receive the real LinkedIn `createAccount challengeUrl` security-verification response.
- Commit a validated baseline before deeper diagnostic experiments. If a change re-enables or changes diagnostic capture, prove it by rerunning `linkedin_register` with `WELES_REGISTER_BROWSER=chromium WELES_FULL_DIAGNOSTICS=1 WELES_DISABLE_RECORDING=1`.
- Full diagnostics should keep useful capture active without page-visible leaks or browser hangs. Safe defaults currently include reduced Chromium netlog and passive CDP firehose; the old heavy modes (`--net-log-capture-mode=Everything`, CDP all-domain firehose) should stay explicit escalation paths only.
- After each trajectory run, inspect artifacts to prove diagnostics were active: `netlog.json` should exist when safe netlog is enabled, and the inst dump should show `cdp_firehose_mode: "passive"` with nonzero `cdp_firehose` events and no overflow. Then clean up any lingering trajectory node process.

Exact commands for this validation loop:

```bash
cd /Users/jakubtowarek/Projects/wisent-weles

# 1. Check for stale trajectory/browser state before the run.
ps -axo pid,ppid,command | rg 'linkedin_register|playwright_chromiumdev_profile|weles-fp-|Google Chrome for Testing|Chromium|firefox|Nightly'

# 2. If stale linkedin_register/browser processes are present, kill only those stale PIDs.
# Example:
# kill <stale_pid_1> <stale_pid_2>

# 3. Build because linkedin_register imports from dist.
npm run build

# 4. Run focused regression tests.
npm test -- --run tests/linkedin-register-guard.test.mjs tests/proxy.test.ts tests/linkedin-register-preflight.test.mjs

# 5. Run the real trajectory with full safe diagnostics.
rm -rf recordings/linkedin_register
WELES_REGISTER_BROWSER=chromium WELES_FULL_DIAGNOSTICS=1 WELES_DISABLE_RECORDING=1 \
  node --env-file=/Users/jakubtowarek/Downloads/supabase-files/.env.local \
       --env-file=/Users/jakubtowarek/Downloads/env.txt \
       scripts/trajectories/linkedin_register.mjs

# 6. Expected meaningful non-hanging run markers:
# [async_api] netlog: .../recordings/linkedin_register/netlog.json mode=safe
# [wsession] 000_goto_signup OK result=navigated to https://www.linkedin.com/signup
# [linkedin_register] signup form ready after 1 attempt(s)
# [register] fill email+pwd: ok
# [register] submit1 api=POST status=200 url=https://www.linkedin.com/signup/api/verifyPassword
# [register] click Continue: true
# [register] createAccount status=200 ... challengeUrl=/checkpoint/challengeIframe/...

# 7. Prove diagnostics were active and non-overflowing.
jq '{cdp_firehose_mode, cdp_firehose_count:(.cdp_firehose|length), cdp_firehose_overflow, netlog_file:(.sibling_files[]? | select(.name=="netlog.json") | {name,size}), stdout_last:(.stdout[-4:] // [])}' \
  recordings/linkedin_register/linkedin_register_*.inst.json

ls -lh recordings/linkedin_register/netlog.json recordings/linkedin_register/linkedin_register_*.inst.json

# 8. Clean up any lingering trajectory/browser process after close.
ps -axo pid,ppid,command | rg 'linkedin_register|playwright_chromiumdev_profile|weles-fp-|Google Chrome for Testing|Chromium|firefox|Nightly'
# kill <lingering_pid>
```
