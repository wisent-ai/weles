import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { CaptchaSolver } from '../../dist/captcha/solver.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanIdlePause } from '../../dist/human/mouse.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { persistFreshCookieJar } from './_shared/cookie-freshness.mjs';
import { solveLinkedinCheckpoint, injectV3LoginToken } from './_shared/linkedin/checkpoint.mjs';
import { captureLinkedinPxStorage, restoreLinkedinPxStorage } from './_shared/linkedin/px_storage.mjs';

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

// 2026-05-03: removed WELES_DISABLE_HTTP2=1 and WELES_USE_STOCK_CHROMIUM=1
// defaults. Diff harness against chrome reference proved PerimeterX never
// bootstrapped on weles — every PX storage key, XHR endpoint, and event
// listener was missing. Root cause: those two flags cripple the fingerprint.
//
// HTTP/2 disabled forces HTTP/1.1, which LinkedIn's edge sees instead of
// the h2 fingerprint real Chrome 147 sends (response confirmed
// x-li-proto: http/2 for the chrome reference's session).
//
// Stock Chromium skips the entire weles-patched binary path in async_api.ts
// (line 143: isCustomBinary requires WELES_USE_STOCK_CHROMIUM !== '1'),
// bypassing the canvas / UA / HEVC / ALPS / JA4 fingerprint patches that
// take effect at the browser-binary level (BEFORE any JS init script can
// run). LinkedIn's edge fingerprints us at first byte, decides we aren't
// real Chrome, and serves a stripped /login HTML without the PX script
// tag — leaving every captcha solve to be rejected at the trust layer
// regardless of which tiles we click.
//
// The original justification ("custom weles binary intermittently returns
// ERR_TUNNEL_CONNECTION_FAILED through PacketStream/BrightData") was a
// proxy-layer bug. We now use Oxylabs primarily; if tunnel issues recur,
// fix the proxy layer or rotate provider — do not strip the fingerprint
// patches as a workaround.
if (process.env.WELES_NOPECHA_EXT == null) process.env.WELES_NOPECHA_EXT = '1';
if (process.env.WELES_NOPECHA_EXT_DIR == null) process.env.WELES_NOPECHA_EXT_DIR = `${process.env.HOME ?? '/home/lukaszbartoszcze'}/weles/var/nopecha-ext`;

// Sticky proxy URL per call. Prefer Oxylabs — verified 2026-05-02 via curl
// that Oxylabs/PacketStream/direct return HTTP 200 on linkedin.com/login while
// BrightData returns HTTP 000 (LinkedIn edge-blocks brightdata residential
// for this customer's IP range).
function freshBrightdataUrl() {
  if (process.env.OXYLABS_USERNAME && process.env.OXYLABS_PASSWORD) {
    const sess = Math.floor(Math.random() * 9000000 + 1000000);
    const stickyUser = `customer-${process.env.OXYLABS_USERNAME}-cc-us-sessid-${sess}`;
    return `http://${encodeURIComponent(stickyUser)}:${encodeURIComponent(process.env.OXYLABS_PASSWORD)}@pr.oxylabs.io:7777`;
  }
  if (process.env.BRIGHTDATA_USERNAME && process.env.BRIGHTDATA_PASSWORD) {
    const u = process.env.BRIGHTDATA_USERNAME.startsWith('brd-customer-')
      ? process.env.BRIGHTDATA_USERNAME
      : `brd-customer-${process.env.BRIGHTDATA_USERNAME}-zone-${process.env.BRIGHTDATA_ZONE ?? 'residential_proxy1'}`;
    const sess = Math.floor(Math.random() * 9000000 + 1000000);
    const stickyUser = `${u}-country-us-session-${sess}`;
    return `http://${encodeURIComponent(stickyUser)}:${encodeURIComponent(process.env.BRIGHTDATA_PASSWORD)}@brd.superproxy.io:22225`;
  }
  return null;
}
// 2026-05-03: removed unconditional fresh-sticky override. The previous
// `freshBrightdataUrl() => PROXY_URL_FORCE=1` block ALWAYS picked a new
// Oxylabs sticky session, bypassing metadata.proxy. That made every login
// hit LinkedIn from a different exit IP than the registration session, which
// LinkedIn's risk model treats as account-takeover-in-progress and pushes
// to /checkpoint regardless of credentials.
//
// resolveAccountSession (src/account/session.ts) already prefers
// metadata.proxy when it's not burned/legacy/capability-failed, falling
// back to dynamic provider selection only if the stored proxy is dead.
// Letting that happen naturally pins each login to the account's stable
// exit-IP cohort. Operators can still force a sticky via env if needed.

let { proxyUrl, persona } = await resolveAccountSession(acct);
let s = await WSession.start({ label: 'linkedin_login', proxy: proxyUrl, persona });

// async_api sets context.setDefaultNavigationTimeout(0) (unbounded) for
// long Arkose iframe loads on tiktok signup. We need an explicit cap here
// so a stalled Oxylabs sticky session doesn't burn the worker's 600s budget
// (verified 2026-05-03: 3-of-6 test rows hit SIGKILL with no log line past
// launchPersistentContext — goto was hung).
const GOTO_MS = 30 * 1000;
async function gotoLogin() {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await s.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
      const url = s.page.url?.() ?? '';
      if (!url.startsWith('chrome-error://')) return;
      console.log(`[linkedin_login] goto attempt ${attempt + 1}: chrome-error, retrying with fresh proxy`);
    } catch (e) {
      const msg = e.message ?? '';
      const retriable = /ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|chrome-error|Timeout/.test(msg);
      if (!retriable || attempt >= 4) throw e;
      console.log(`[linkedin_login] goto attempt ${attempt + 1}: ${msg.slice(0, 80)}, retrying with fresh proxy`);
    }
    await s.close().catch(() => {});
    const next = freshBrightdataUrl();
    if (next) { process.env.PROXY_URL = next; process.env.PROXY_URL_FORCE = '1'; }
    ({ proxyUrl, persona } = await resolveAccountSession(acct));
    s = await WSession.start({ label: 'linkedin_login', proxy: proxyUrl, persona });
  }
  await s.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded', timeout: GOTO_MS });
}

async function captureCookies() {
  if (!acct.id) return;
  try {
    const cookies = await s.ctx.cookies();
    await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl, currentPersona: persona });
  } catch (e) { console.log('[cookie-capture] err:', e.message); }
}

function writeBan(signal, details) {
  try {
    const dir = join(process.cwd(), 'recordings', 'linkedin_login');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'linkedin_login', signal, healthy: signal === 'healthy', details: details ?? {}, ts: new Date().toISOString() }, null, 2));
  } catch {}
}

async function markStaleAndFail(reason, finalUrl, signal = 'checkpoint') {
  writeBan(signal, { final_url: finalUrl, reason });
  const { markCookiesStale } = await import('../../dist/utils/credentials.js');
  if (acct.id) await markCookiesStale(acct.id);
}

const CHECKPOINT_RE = /\/(checkpoint|uas\/login|login\/recovery)/;

try {
  await gotoLogin();
  // Restore PerimeterX localStorage from prior successful session (if any)
  // BEFORE waiting for the page to hydrate. PX reads __pxvid and px_fp on
  // bootstrap; once the bundle has run those reads, injecting later is a
  // no-op. Page is already on linkedin.com origin after gotoLogin so
  // localStorage writes hit the right origin.
  await restoreLinkedinPxStorage(s, acct).catch(() => {});
  await s.page.waitForTimeout(2500);
  // Pre-form-render checkpoint: PerimeterX edge-redirects flagged proxy IPs
  // from /login → /checkpoint/challenge before SDUI form renders. Detect
  // here so the form-fill below doesn't time out 30s on inputs that won't
  // appear.
  {
    const earlyUrl = s.page.url?.() ?? '';
    if (CHECKPOINT_RE.test(earlyUrl)) {
      console.log(`[linkedin_login] pre-form checkpoint at ${earlyUrl} — solving captcha first`);
      const r = await solveLinkedinCheckpoint(s, 'pre-form');
      if (r.liAt) {
        await captureCookies();
        await captureLinkedinPxStorage(s, acct).catch(() => {});
        writeBan('healthy', { final_url: r.finalUrl });
        console.log(`PASS: li_at cookie set via pre-form captcha solve — ${r.finalUrl}`);
        await s.close().catch(() => {});
        process.exit(0);
      }
      throw new Error(`pre-form captcha solver failed at ${r.finalUrl}`);
    }
  }
  // Degraded /login skeleton: LinkedIn serves a 13KB SSR shell (no SDUI
  // bootstrap, no inputs) to suspect IPs. Fast-fail on zero inputs after
  // hydration so the form-fill below doesn't time out.
  {
    const inputCount = await s.page.evaluate(() => document.querySelectorAll('input').length).catch(() => -1);
    if (inputCount === 0) {
      const bodyText = await s.page.evaluate(() => (document.body?.innerText ?? '').slice(0, 500)).catch(() => '');
      throw new Error(`degraded_login_shell: 0 inputs after hydration window; body=${JSON.stringify(bodyText.slice(0, 200))}`);
    }
  }
  // flagship3 SDUI (current 2026-05): id=":r3:" type="email" autocomplete=
  // "username webauthn". Old shells: id=username, name=session_key.
  // Use locator click+humanType so the React onChange fires.
  const usernameSel = 'input#username, input[name="session_key"], input[type="email"][autocomplete*="username"], input[type="email"]';
  const passwordSel = 'input#password, input[name="session_password"], input[type="password"][autocomplete*="current-password"], input[type="password"]';
  const userLoc = s.page.locator(usernameSel).filter({ visible: true }).first();
  await userLoc.waitFor({ state: 'visible' });
  await userLoc.click({ force: true });
  await humanIdlePause('short');
  await humanType(s.page, process.env.SVC_EMAIL ?? '');
  await humanIdlePause('short');
  const pwLoc = s.page.locator(passwordSel).filter({ visible: true }).first();
  await pwLoc.click({ force: true });
  await humanIdlePause('short');
  await humanType(s.page, process.env.SVC_PASSWORD ?? '');
  await humanIdlePause('short');
  // LinkedIn serves two login shells:
  //   (A) Legacy checkpoint-frontend: <form> + <button type="submit">,
  //       PerimeterX iframe gates the click handler that POSTs
  //       /checkpoint/pk/initiateLogin then submits to /checkpoint/lg/login-submit.
  //   (B) flagship3 SDUI: <button type="button"> with React onClick that
  //       POSTs /flagship-web/rsc-action/actions/server-request.
  // getByRole('button', name='Sign in') finds the submit on either shell.
  // force:true + noWaitAfter avoids React-rerender deadlocks and missing
  // navigation on SDUI's in-place fetch.
  const submitBtn = s.page.getByRole('button', { name: /^\s*sign\s*in\s*$/i }).filter({ visible: true }).first();
  await submitBtn.waitFor({ state: 'visible' });
  await injectV3LoginToken(s.page);
  await submitBtn.click({ force: true, noWaitAfter: true });
  for (let i = 0; i < 12; i++) {
    await s.page.waitForTimeout(1000);
    if (!/^https?:\/\/www\.linkedin\.com\/login\/?$/.test(s.page.url())) break;
  }
  console.log(`[linkedin_login] post-submit url=${s.page.url()}`);

  let cookies = await s.ctx.cookies();
  let liAt = cookies.find((c) => c.name === 'li_at' && c.value);
  let finalUrl = s.page.url?.() ?? '';
  let title = await s.page.title?.().catch(() => '') ?? '';
  let onCheckpoint = CHECKPOINT_RE.test(finalUrl) || /Security Verification/.test(title);

  // Post-submit checkpoint: route through the V2 enterprise solver. Old
  // path called solvePerimeterX which CapSolver returns ERROR_TYPE_NOT_SUPPORTED
  // for — never produced cookies. V2 enterprise solves the actual reCAPTCHA
  // image-grid LinkedIn shows on /checkpoint/challenge.
  if (!liAt && onCheckpoint) {
    const r = await solveLinkedinCheckpoint(s, 'post-submit');
    liAt = r.liAt;
    finalUrl = r.finalUrl;
    onCheckpoint = CHECKPOINT_RE.test(finalUrl);
  }

  if (liAt) {
    await captureCookies();
    await captureLinkedinPxStorage(s, acct).catch(() => {});
    writeBan('healthy', { final_url: finalUrl });
    console.log(`PASS: li_at cookie set — ${finalUrl}`);
  } else if (onCheckpoint) {
    await markStaleAndFail('linkedin issued V2 enterprise captcha; CapSolver token did not satisfy /checkpoint', finalUrl);
    console.log(`FAIL: linkedin checkpoint — ${finalUrl} (cookies marked stale)`);
    process.exitCode = 1;
  } else if (finalUrl.startsWith('chrome-error://')) {
    writeBan('proxy_failed', { final_url: finalUrl, reason: 'chrome-error: proxy CONNECT failed before login completed' });
    console.log(`FAIL: proxy_failed — ${finalUrl}`);
    process.exitCode = 1;
  } else if (/^https:\/\/www\.linkedin\.com\/login(\/|\?|$)/.test(finalUrl)) {
    // Bounce back to /login = credentials rejected or session_redirect loop.
    // Mark stale so routine cron stops re-attempting against a dead account.
    await markStaleAndFail('submit returned to /login — credentials rejected or session_redirect loop', finalUrl);
    console.log(`FAIL: linkedin login bounced back — ${finalUrl} (cookies marked stale)`);
    process.exitCode = 1;
  } else {
    await markStaleAndFail('no li_at cookie set after submit', finalUrl);
    console.log(`FAIL: no li_at cookie — ${finalUrl} (cookies marked stale)`);
    process.exitCode = 1;
  }
} catch (e) {
  // ERR_HTTP_RESPONSE_CODE_FAILURE = LinkedIn 4xx/5xx at edge (fingerprint or
  // IP blocked). Must classify as ip_blocked so worker-pool auto-markBurned
  // fires. ERR_TUNNEL_CONNECTION_FAILED = real proxy CONNECT failure.
  const finalUrl = s.page?.url?.() ?? '';
  let sig = 'unknown_error';
  const msg = e.message ?? '';
  if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/.test(msg)) sig = 'ip_blocked';
  else if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(msg)) sig = 'proxy_failed';
  else if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
  else if (/Timeout|net::ERR_TIMED_OUT/.test(msg)) sig = 'proxy_failed';
  else if (CHECKPOINT_RE.test(finalUrl) || /image-selection|select.*buses|solve_captcha/i.test(msg)) {
    sig = 'checkpoint';
    const { markCookiesStale } = await import('../../dist/utils/credentials.js');
    if (acct.id) await markCookiesStale(acct.id);
  }
  writeBan(sig, { final_url: finalUrl, error: msg.slice(0, 200) });
  console.log('FAIL:', msg.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
