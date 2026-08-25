# Burn attribution (paired-comparison policy)

The system never marks a (domain, platform) or (IP, platform) combo as
burned from a single failure. Attribution requires a paired counterfactual:
two runs differing in exactly one factor where the outcomes flip. Without
the counterfactual, the failure is logged but no burn is written.

## Components

Weles submits every diagnostic trajectory through Stado. Each submission carries
an exact Skarbiec account item and non-secret experiment parameters; proxy
credentials resolve only on the selected worker. Run output is retained by
Stado rather than copied into a Weles database queue.

`scripts/debug/instrument_chrome.mjs` remains the human-reference capture for
browser-context comparisons. It reads account cookies from Skarbiec and writes
the capture below the run recording directory or `~/.stado/work`.

## Data flow

1. Submit each comparison action through Stado with the same account item.
2. Stado serializes and places the jobs; Weles records exit IP and ban signals.
3. Compare the retained Stado results while changing exactly one of domain or
   exit IP.

## Writers

Weles does not write burn state or synthetic diagnostic rows to a database.
Any consumer that derives burn policy from completed runs must consume the
Stado result records.

## Running an isolation comparison

Submit the real Weles actions through `stado submit` or a checked-in producer
using `scripts/_shared/stado-action-queue.mjs`, then inspect each exact job with
`stado status <job-id>` and `stado results <job-id>`.

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
