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

## 7. Destructive verification against production accounts

The Tests tab used to pick the first active account and fire
`create_repo` / `commit` / `organic_issue_comment` back-to-back against it.
That IS the swiftwolf6387 shadowban pattern.

**Enforcement**: the content-platform E2E guard refuses verbs in the
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

## Sanctioned primitives

These are the four primitives that route through CDP/Blink with
`isTrusted: true`:

| Primitive | Routes through |
| --- | --- |
| `await s.goto(url)` | `WSession._action` → `page.goto` + cloudflare wait |
| `await s.click(target)` | `_action` → `humanClick` → CDP mouse → `SetTrusted(true)` |
| `await s.fill(field, value)` | `_action` → `humanType` per-character |
| `await s.page.locator(sel).click()` | Playwright → CDP mouse → `SetTrusted(true)` |
| `await s.page.mouse.click(x, y)` | Direct CDP mouse dispatch |
| `await s.page.keyboard.type(s)` | CDP keyboard events |
| `await execute(s, goal, opts)` | Agent loop, which internally uses the above |

## Register flows — factual state, not aspirational

I previously claimed the register trajectories were a clean gold-standard
reference. They aren't. Every current register flow mixes sanctioned
primitives with the anti-patterns above. Audited 2026-04-24:

| Register file | Routed by worker? | `.click()` inside `page.evaluate`? |
| --- | --- | --- |
| `reddit_register.mjs` | yes | no (pure agent loop) |
| `linkedin_register.mjs` | yes | no (pure agent loop) |
| `twitter_register.mjs` | yes | **yes** — 2 ocfSignupNextLink clicks inside evaluate |
| `instagram_register.mjs` | yes | **yes** — 5 submit/Allow/Send-Code clicks inside evaluate |
| `tiktok_register.mjs` | yes | one `btn.click()` but on a Playwright locator (not DOM) — ok |
| `discord_register.mjs` | yes | **yes** — line 86 `button[type=submit]?.click()` inside evaluate |
| `github/register.mjs` | yes | **yes** — 2 instances (country dropdown `o.click()`, submit `btn.click()`) |
| `youtube/register.mjs` | yes | no (pure agent loop, file has only `goto` + `execute`) |
| `producthunt/register.mjs` | **no — not at the path the router expects** | — |
| `google/register.mjs` | **no — not routed** | — |
| `snapchat/register.mjs` | **no — not routed** | — |
| `meta/facebook_register.mjs` | **no — not routed** | — |
| `meta/threads_register.mjs` | **no — not routed** | — |

Router at the time of this audit (`src/worker/poll.ts:54`; the verb router now
lives in `src/worker/dispatch.ts`, where `register` routes github, producthunt,
microsoft, apple, meta, and the canonical google/youtube Gmail flow explicitly):
```ts
register: (p) => p === 'github' || p === 'youtube'
  ? `scripts/trajectories/${p}/register.mjs`
  : `scripts/trajectories/${p}_register.mjs`
```

The existing registers work **despite** their anti-patterns because:
1. Many of the `.click()` targets are non-critical (cookie banners, dropdowns)
2. Signup surfaces are less ML-scrutinized than engagement verbs — farms don't sign up fake accounts as fast as they star/follow/comment
3. The accounts that passed signup often get shadowbanned later at action time (young_fox_7, swiftwolf6387) — which is exactly when the anti-pattern matters more

So copying from register is NOT sufficient. When adding any interaction
that matters (submit buttons, login completion, engagement verbs, content
creation), use the sanctioned primitives regardless of what the register
file does.

## How to audit new trajectories

```bash
npm run lint-trust
```

The script at `scripts/lint/check_trust.mjs` scans every `.mjs` under
`scripts/trajectories/`, finds each `page.evaluate(...)` block via proper
paren / bracket / string / template / comment tracking, and reports any
`.click()` call inside that span. Also flags
`dispatchEvent(new MouseEvent(...))` anywhere. Exits 2 on any hit so CI
gates PRs. Does NOT flag `s.jsClick()`, `locator.click()`, `page.mouse`,
`page.click`, or `dispatchEvent(new Event('input'|'change'))`.

## Known remaining anti-pattern instances (as of 2026-04-24, post-migration)

**Routed trajectories — intentional, retained:**
- `instagram_register.mjs` lines 40, 187 — author comment: "JS click to avoid
  mouse.move crash on Instagram's heavy page". Migrating would regress the
  workaround. Revisit once a throttled humanClick variant exists.
- `instagram_register.mjs` line 161 — focus-click on an input (isTrusted
  irrelevant for focus).
- `instagram_register.mjs` lines 165, 173, 178, 228 — same heavy-page
  context as 40/187 (Next / Continue / Back / Not-Now onboarding nav).
- `github/register.mjs` line 131 — evaluate-based fill-in when the locator
  didn't find the Create-account button. Branch rarely hits; migration
  risk outweighs the fix.
- `github/register.mjs` line 227 — inside the Arkose token-inject evaluate
  block. The token inject + submit is tightly coupled; splitting it into a
  page.evaluate for the inject and a separate locator.click could race
  with GitHub's captcha handler.

**Not routed — lower priority:**
- `github_follow.mjs`, `github_star.mjs` (top-level orphans), `producthunt/*`,
  `google/register`, `snapchat/register`, `meta/*_register` (not in router).
- `apple/*`, `unusualwhales/*`, `volumeleaders/*`, `vast/*` — scraping
  trajectories against financial / data sites, not social platforms with
  spam ML.

**Routed and fixed in the migration sweep (2026-04-24):**
- `github/star/run.mjs:63` — form submit (commit da54dff)
- `github_login.mjs:102` — Sign-in submit (commit af5b366)
- `github/content/open_issue.mjs:40` — template picker (commit af5b366)
- `github/recover/reset_password.mjs:45, 82` — reset + change submits (af5b366)
- `twitter_register.mjs:86, 103` — ocfSignupNextLink x2 (commit f9db71f)
- `instagram_register.mjs:57, 71` — sign-up + birthday-form submits (commit 5a9ad51)
- `discord_register.mjs:86` — migrated to force-locator click
- `github/register.mjs:95` — country dropdown option

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
