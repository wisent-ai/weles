# Burn attribution (paired-comparison policy)

The system never marks a (domain, platform) or (IP, platform) combo as
burned from a single failure. Attribution requires a paired counterfactual:
two runs differing in exactly one factor where the outcomes flip. Without
the counterfactual, the failure is logged but no burn is written.

## Components

| Where | What |
|---|---|
| `content-platform/src/lib/burn-attribution/runner.ts` | The matcher. Reads recent `_register` rows from `account_action_logs`, finds paired rows differing in exactly one factor (domain or exit_ip), and writes the burn against the differing factor. Singleton failures with no pair produce nothing. |
| `content-platform/src/app/api/(infra)/(jobs)/cron/(automation)/burn-attribution/route.ts` | Cron handler. Vercel schedule `17 */4 * * *` (every four hours). |
| `weles/scripts/debug/paired/run.mjs` | Test-row queuer CLI. Inserts N paired rows into `account_action_logs` with the right `params.proxy_url_override` + `params.force_email_domain` for the desired isolation experiment. |
| `weles/scripts/debug/instrument_chrome.mjs` | Human-reference capture. Accepts `PROXY_URL` so the chrome reference runs from the same IP as the weles trajectory under test — required for isolating browser-context delta from IP delta. |
| `weles/src/worker/dispatch.ts` | Translates `params.force_email_domain` → `FORCE_EMAIL_DOMAIN` env var, consumed by `pickDomain()` so the trajectory respects the pinned domain. |
| `weles/src/session/wsession.ts` | Probes the actual exit IP via `ctx.request.get(api.ipify.org)` at session start; writes into `result.session.exit_ip`. The matcher uses this field to identify the IP factor. |

## Data flow

1. CLI inserts N rows. All rows share `account_id` so the worker's per-account in-flight lock serializes them — personas/timings/captcha state vary as little as the worker allows.
2. Worker claims each row in turn, runs the trajectory, records `result.session.exit_ip` + `result.ban_signal` + `result.artifacts` on completion.
3. Next cron tick: matcher reads recent failed rows. For each failed row R, finds paired row P with same platform, opposite outcome, exactly one factor differing. Writes burn against the differing factor + stamps `result.attribution` on both rows so the pair isn't re-scored.
4. Future trajectory's `pickDomain` / `isBurned` reads consume the burn writes.

## Writers (the only sources of new burns)

- `system_settings.burned_proxies.hosts[host].platforms` — written by `burn-attribution` cron when `exit_ip` is the differing factor
- `inbound_email_domains.metadata.platform_blocks[platform]` — written by `burn-attribution` cron when `domain` is the differing factor

Nothing else writes to these. The legacy `poll.ts:237` singleton-failure burn writer was removed in `weles@3073b3c`. The legacy `_register` burn writer in `poll.ts` was reverted in `weles@4cd2eb4`.

## Running an isolation test

```sh
# Vary the IP, hold the domain constant — does which IP differ change the outcome?
node scripts/debug/paired/run.mjs \
  --platform=linkedin --action=linkedin_register \
  --vary=ip --hold-domain=mailpost847.com \
  --pools=decodo,oxylabs-dedicated-isp

# Vary the domain, hold the IP constant — does which domain differ change the outcome?
node scripts/debug/paired/run.mjs \
  --platform=linkedin --action=linkedin_register \
  --vary=domain --hold-ip=isp.decodo.com:10001 \
  --domains=inboxmail659.com,mailpost847.com,pilatesguild.com
```

The CLI prints a `tag namespace` like `paired_ip_<ts>` — query
`account_action_logs` later via `params->>source=like.<tag>%` to see results.

## Same-IP chrome reference (browser-context isolation)

To test whether browser fingerprint vs IP class is the cause:

```sh
PLATFORM=linkedin \
TARGET_URL=https://www.linkedin.com/signup \
PROXY_URL=http://<user>:<pass>@isp.decodo.com:10001 \
node scripts/debug/instrument_chrome.mjs
```

Then diff the resulting `chrome_linkedin_<ts>.json` against a weles
`linkedin_register_<ts>.json` from the same IP. Remaining delta attributes
to browser context only.

## Policy boundaries

- Singleton failures NEVER produce a burn — this is the entire point of the policy
- Attribution requires `(R₁.status != R₂.status) AND (exactly one of {domain, exit_ip} differs)`
- If multiple factors differ, the matcher skips the pair (can't isolate)
- If both factors are equal but outcomes differ, the matcher skips the pair (factor is something not in {domain, exit_ip} — would need persona/fingerprint/timing instrumentation to attribute)
- The cron only writes; it never clears. Manual cleanup is required if a burn becomes stale; we audited and removed legacy non-paired entries in this session
