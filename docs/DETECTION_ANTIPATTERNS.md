# Weles detection anti-patterns

Canonical list of patterns that get our accounts banned. When writing or
reviewing a trajectory, grep for each of these — every one has a history of
burning an account and a sanctioned replacement that uses the native weles
primitive.

## 1. `el.click()` inside `page.evaluate(...)` on real interactions

JS-dispatched click events carry `isTrusted: false` in the DOM event object.
Platforms read that flag directly to detect automation.

```js
// BAD — blink dispatches with isTrusted:false
await s.page.evaluate(() => {
  const btn = document.querySelector('button[type="submit"]');
  if (btn) btn.click();
});

// GOOD — s.click routes through humanClick -> CDP mouse -> Blink pointer
//        pipeline -> pointer_event_factory.cc SetTrusted(true)
await s.click('Star this repository');
// or by CSS:
await s.page.locator('form[action$="/star"] button[type="submit"]').click();
```

**Symptoms on the wire (in `result.ban_signal`)**
- TikTok `/passport/web/email/register_verify_login/` returns `{"error_code":7,"description":"Maximum number of attempts reached"}` → detector stamps `rate_limited`
- Arkose (Twitter/GitHub/Discord) — widget never solves, score submits rejected
- Reddit Kasada — `captcha_challenge` on next navigation
- Instagram `/api/v1/*` → `{"feedback_required":"..."}` → detector stamps `checkpoint`
- GitHub spam ML — engagement verbs silently no-op, then shadowban on next write

**Historical cost**
- `src/human/select.ts` ce369f6 — TikTok signup blocked for weeks until Apr 2026
- `scripts/trajectories/github/star/run.mjs` — fixed 2026-04-24 (this ref)
- `scripts/trajectories/github/content/open_issue.mjs`, `.../recover/reset_password.mjs` — still have the pattern as of this doc

**Exception**: `s.jsClick(selector, text)` is the deliberate escape hatch for
Shadow DOM (Reddit new reddit renders buttons inside shadow roots the CDP
pipeline can't reach). The `js` prefix is required so reviewers flag it.
Never use it outside shadow-DOM cases.

## 2. `dispatchEvent(new MouseEvent(...))` anywhere

Same `isTrusted: false` problem as #1. Even worse because the intent is more
clearly bot-like — humans never dispatch MouseEvent directly.

```js
// BAD
el.dispatchEvent(new MouseEvent('click', { bubbles: true }));

// GOOD
await s.click(target);  // or s.page.locator(sel).click();
```

## 3. Instant fills via `el.value = "x"` without `humanType` delay

```js
// BAD — keystrokes submit at 0ms intervals, no keydown/keyup, no composition
//       events, no focus transitions. Arkose and TikTok slider solvers time
//       this to sub-ms and flag.
await s.page.evaluate(`document.querySelector('input').value = "${email}"`);

// GOOD
await s.fill('email', email);   // humanType with per-char delay
```

**Exception — React-controlled inputs**: React overrides the input's value
setter and ignores direct assignment. The canonical pattern is:

```js
const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
setter.call(el, value);
el.dispatchEvent(new Event('input', { bubbles: true }));
```

This is ONLY OK when `s.fill` won't work (React component breaks on native
input events). It's a fill-only escape; never extend it to clicks.

## 4. Direct navigation to authed content without UI warmup

Jumping from login → content verb → exit looks nothing like a human session.
Real users land on the homepage, scroll, click a nav item, then engage.

```js
// BAD — register, immediately submit on fresh account
await register(acct);
await s.goto('https://reddit.com/submit');   // first action is a submit
await post(title, body);

// GOOD — warm up first
await register(acct);
await s.goto('https://reddit.com/');
// scroll, dwell, browse for a few cycles before any write verb
```

**Symptoms**
- Reddit crowd-control auto-shadowban (young_fox_7 incident)
- GitHub spam-ML flag on first repo/commit (swiftwolf6387)
- TikTok slider on every login after fresh signup

**Enforcement**: the `warming → mature` gate in
`content-platform/src/lib/platform/_shared/lifecycle.ts` now requires
platform-specific graph signatures (GitHub: 10 stars, 3 follows, 5
profile_views; Reddit: 5 organic_comments) before any write verb is in
the action menu.

## 5. Fingerprint drift between register and action sessions

If register ran with canvas seed A, UA X, timezone Y, and the next login
session has canvas seed B, UA X.1, timezone Z, the platform correlates the
cohort and distrusts both sessions.

**Never** override persona fields between register and action sessions.
`resolveAccountSession` in `src/utils/credentials.ts` pins `metadata.persona`
at first signup; use it, don't regenerate.

## 6. Fleet-wide proxy correlation (shared /16)

Every reddit account exiting through the same Oxylabs BR /16 means one
flagged IP poisons the whole cohort.

**Enforcement**: `resolveAccountSession` hashes `account.id` to pick a
provider from `[oxylabs, packetstream, pingproxies]` deterministically. Same
account always pins to the same provider, fleet spreads evenly across three.

## 7. Smoke tests firing destructive verbs at production accounts

The Tests tab used to pick the first active account and fire
`create_repo` / `commit` / `organic_issue_comment` back-to-back against it.
That IS the swiftwolf6387 shadowban pattern.

**Enforcement**: `e2e-smoke` cron in content-platform refuses verbs in the
`DESTRUCTIVE_VERBS` set against production accounts and enforces a cooldown
gate at enqueue time.

## 8. Playwright identifier leaks into the page context

`window.__playwright_global_listeners_check__` and related symbols are
hard-coded in `node_modules/playwright-core/lib/generated/injectedScriptSource.js`
and are read directly by Arkose's pre-widget tier decision.

**Enforcement**: VM boot script sed-renames the three `__playwright_*`
identifiers to `__wpc_*_fb3e7a__` and removes
`_setupGlobalListenersRemovalDetection()`. If the VM is re-provisioned, the
sed step must run before the worker starts.

## 9. Open-source Chromium codec/API gaps (Chrome 147 stubs missing)

HEVC returns `""`, audio codecs return `""`, `window.Sanitizer` is
`undefined`. TikTok's `enhanced_fp.audio_codecs` check and GitHub's Arkose
Bda plaintext both read these.

**Enforcement**: `chrome147_stubs.js` must be in `DEFAULT_SCRIPTS` in
`src/scripts/loader.ts`. If removed, TikTok `/passport/web/region/` returns
an empty decoy body before any login attempt runs.

## 10. `--disable-http2` or any other Chromium flag drift

Previously added to `CHROMIUM_ARGS` in `src/async_api.ts` as a PacketStream
workaround. Broadcast ALPN `http/1.1` only, missing TLS extension
`application_settings (17613)` (ALPS), no HTTP/2 akamai fingerprint. Gave
every weles session a perfect stable counter key across proxies.

**Enforcement**: the flag is removed. JA4 should be
`t13d1516h2_8daaf6152771_d8a2da3f94cd` on every session. If you see
`t13d1515h1_...`, something reintroduced `--disable-http2`.

## How to verify a new trajectory is clean

```bash
# Grep the trajectory for the direct anti-patterns
grep -nE '\.click\(\)|dispatchEvent\(new (MouseEvent|KeyboardEvent|Event\(.(?!input|change))' scripts/trajectories/<path>.mjs

# Any hit that isn't inside s.jsClick / a React-controlled fill helper is a bug.
```

If you're adding a new platform interaction, default to `s.click`, `s.fill`,
`s.type`, `s.focus`. They all go through `_action()` in wsession.ts which
captures before/after screenshots automatically and routes events via CDP
with `isTrusted=true`.
