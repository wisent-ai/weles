# Agent Notes

## LinkedIn trajectory diagnostics workflow

- Before every browser or trajectory test, clean up or explicitly verify there are no stale `linkedin_register`, Weles Chromium, Playwright Chrome for Testing, Firefox/Nightly, `playwright_chromiumdev_profile`, or `weles-fp-` processes. Stale browser state has caused misleading LinkedIn and navigation results.
- For LinkedIn register work, validate diagnostics changes with the real trajectory, not only toy navigation checks. The meaningful non-hanging result is: load signup, submit email/password, reach first/last-name form, click Continue, then receive the real LinkedIn `createAccount challengeUrl` security-verification response.
- Commit a validated baseline before deeper diagnostic experiments. If a change re-enables or changes diagnostic capture, prove it by rerunning `linkedin_register` with `WELES_REGISTER_BROWSER=chromium WELES_FULL_DIAGNOSTICS=1 WELES_DISABLE_RECORDING=1`.
- Full diagnostics should keep useful capture active without page-visible leaks or browser hangs. Safe defaults currently include reduced Chromium netlog and passive CDP firehose; the old heavy modes (`--net-log-capture-mode=Everything`, CDP all-domain firehose) should stay explicit escalation paths only.
- After each trajectory run, inspect artifacts to prove diagnostics were active: `netlog.json` should exist when safe netlog is enabled, and the inst dump should show `cdp_firehose_mode: "passive"` with nonzero `cdp_firehose` events and no overflow. Then clean up any lingering trajectory node process.
