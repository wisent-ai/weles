import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { CaptchaSolver } from '../../dist/captcha/solver.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanIdlePause } from '../../dist/human/mouse.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { persistFreshCookieJar } from './_shared/cookie-freshness.mjs';

// Direct Playwright fill+click flow — bypasses the agent loop because the
// agent's vision-based 'click' picks the wrong "Sign in" button (matches
// "Sign in with Apple" SSO before the form's Sign in) and times out tearing
// down the browser. /login serves the form directly without the /feed→/uas
// redirect overhead.

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

// Default-on HTTP/2-off for linkedin: PacketStream and BrightData residential
// pools sometimes silently drop h2 frames inside CONNECT, surfacing as
// ERR_TUNNEL_CONNECTION_FAILED. Empirically tunnel reliability with h2 off is
// markedly better against linkedin specifically. Operators can override with
// WELES_DISABLE_HTTP2=0 if they want to verify h2 behavior.
if (process.env.WELES_DISABLE_HTTP2 == null) process.env.WELES_DISABLE_HTTP2 = '1';

let { proxyUrl, persona } = await resolveAccountSession(acct);
let s = await WSession.start({ label: 'linkedin_login', proxy: proxyUrl, persona });
// Goto retry: tunnel connection is flaky, retry up to 3 times with a fresh
// proxy resolution on each attempt. Each call to resolveAccountSession picks
// a different sticky session id, which often resolves to a different exit IP.
async function gotoLogin() {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await s.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
      const url = s.page.url?.() ?? '';
      if (!url.startsWith('chrome-error://')) return;
      console.log(`[linkedin_login] goto attempt ${attempt + 1}: chrome-error, retrying with fresh proxy`);
    } catch (e) {
      const msg = e.message ?? '';
      if (!/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED|chrome-error/.test(msg) || attempt >= 2) throw e;
      console.log(`[linkedin_login] goto attempt ${attempt + 1}: ${msg.slice(0, 80)}, retrying with fresh proxy`);
    }
    await s.close().catch(() => {});
    ({ proxyUrl, persona } = await resolveAccountSession(acct));
    s = await WSession.start({ label: 'linkedin_login', proxy: proxyUrl, persona });
  }
  await s.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
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

try {
  await gotoLogin();
  await s.page.waitForTimeout(2500);
  // Modern LinkedIn login: visible inputs use autocomplete="webauthn" (passkey
  // hint) + current-password. Legacy #username / [name=session_key] selectors
  // are gone. Two duplicate input copies exist — only the visible one accepts
  // fill. Use pressSequentially (per-keystroke events) so React's controlled-
  // input state updates; locator.fill sets DOM value but skips React onChange.
  // flagship3 SDUI (current 2026-05): id=":r3:" type="email" autocomplete="username webauthn"
  // (space-separated, exact-match selectors fail). Old shells (id=username,
  // name=session_key) shipped pre-SDUI. Use type=email + autocomplete*=username
  // to catch SDUI without false-matching unrelated email inputs.
  const usernameSel = 'input#username, input[name="session_key"], input[type="email"][autocomplete*="username"], input[type="email"]';
  const passwordSel = 'input#password, input[name="session_password"], input[type="password"][autocomplete*="current-password"], input[type="password"]';
  // Drive both inputs via JS focus + Playwright keyboard.type. locator.click
  // on either input hangs the full default timeout (LinkedIn intercepts the
  // click during scroll-into-view). JS focus directs keystrokes correctly
  // without going through the click pipeline.
  // Focus + fill via Playwright locators that work on both legacy
  // checkpoint-frontend (input#username / input[name="session_key"]) and
  // flagship3 SDUI (input[type="email"][autocomplete="username webauthn"]).
  // flagship3 inputs have React-generated ids (:r3: etc.) and no name attr,
  // so the legacy querySelectors return null and JS-focus is a no-op —
  // humanType then types into nowhere and the form stays blank.
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
  // Click the Sign-in button via locator.click. LinkedIn now serves two
  // login shells, randomly:
  //   (A) Legacy checkpoint-frontend: <form action="...login-submit"> with
  //       <button type="submit"> inside, PerimeterX iframe gates the click
  //       handler that POSTs /checkpoint/pk/initiateLogin then submits the
  //       form to /checkpoint/lg/login-submit.
  //   (B) New flagship3 SDUI: NO <form>, NO type="submit". Sign-in is
  //       <button type="button"> with React onClick that POSTs the login
  //       payload to /flagship-web/rsc-action/actions/server-request?
  //       sduiid=com.linkedin.sdui.requests.login.authenticate.
  // Use getByRole('button', name='Sign in') to find the submit control on
  // either shell. force:true skips Playwright's actionability deadlock
  // (the React form re-renders during PX/SDUI hydration, never settling).
  // noWaitAfter: SDUI consumes the response in-place via fetch, no full-
  // page nav, so the default post-click nav-wait would time out. JS-driven
  // submit (f.requestSubmit / dispatchEvent) creates isTrusted=false events
  // that React's onClick filter or PerimeterX silent-rejects → bounce.
  // Diff harness 2026-05-02 confirmed: locator.click({force,noWaitAfter})
  // on weles binary fires the POST chain (Fetch.POST:/flagship-web/
  // rsc-action/actions/server-request observed) and the page navigates to
  // /checkpoint/challenge or /feed.
  const submitBtn = s.page
    .getByRole('button', { name: /^\s*sign\s*in\s*$/i })
    .filter({ visible: true })
    .first();
  await submitBtn.waitFor({ state: 'visible' });
  await submitBtn.click({ force: true, noWaitAfter: true });
  for (let i = 0; i < 12; i++) {
    await s.page.waitForTimeout(1000);
    if (!/^https?:\/\/www\.linkedin\.com\/login\/?$/.test(s.page.url())) break;
  }
  console.log(`[linkedin_login] post-submit url=${s.page.url()}`);
  // Don't hand the challenge page to the agent — its solve_captcha tears down
  // the browser on LinkedIn's PerimeterX-wrapped reCAPTCHA. Fall through to
  // CapSolver AntiPerimeterX below (which handles checkpoint specifically).
  // Validate auth + try CapSolver PerimeterX bypass on checkpoint pages.
  let cookies = await s.ctx.cookies();
  let liAt = cookies.find(c => c.name === 'li_at' && c.value);
  let finalUrl = s.page.url?.() ?? '';
  let title = await s.page.title?.().catch(() => '') ?? '';
  let onCheckpoint = /\/(checkpoint|uas\/login|login\/recovery)/.test(finalUrl) || /Security Verification/.test(title);

  // Solve up to 3 times. nocaptcha's PerimeterX endpoint is probabilistic —
  // first solve may yield cookies that LinkedIn rejects (px-cdn fingerprint
  // mismatch), retry usually clears it. Cheap to retry: each call is one
  // HTTPS round-trip to nocaptcha, no Chromium re-launch.
  for (let solveAttempt = 0; solveAttempt < 3 && !liAt && onCheckpoint; solveAttempt++) {
    console.log(`[linkedin_login] checkpoint solve attempt ${solveAttempt + 1}/3 (nocaptcha PerimeterX with our proxy)`);
    const ua = await s.page.evaluate(() => navigator.userAgent).catch(() => '');
    const px = await new CaptchaSolver().solvePerimeterX(finalUrl, ua, cookies.filter(c => /linkedin\.com$/.test(c.domain ?? '')).map(c => ({ name: c.name, value: c.value, domain: c.domain })), proxyUrl);
    if (px && px.length) {
      await s.ctx.addCookies(px.map(c => ({ ...c, domain: c.domain ?? '.linkedin.com', path: c.path ?? '/' }))).catch(e => console.log('[linkedin_login] addCookies err:', e.message));
      await s.page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await s.page.waitForTimeout(3000);
      cookies = await s.ctx.cookies();
      liAt = cookies.find(c => c.name === 'li_at' && c.value);
      finalUrl = s.page.url?.() ?? '';
      title = await s.page.title?.().catch(() => '') ?? '';
      onCheckpoint = /\/(checkpoint|uas\/login|login\/recovery)/.test(finalUrl) || /Security Verification/.test(title);
      console.log(`[linkedin_login] post-bypass attempt ${solveAttempt + 1}: li_at=${!!liAt} url=${finalUrl}`);
      if (liAt) break;
    } else {
      console.log(`[linkedin_login] solver returned no cookies on attempt ${solveAttempt + 1}`);
    }
  }
  // Only persist cookies on the success path. Persisting before the li_at
  // check writes cookies_minted_at to a fresh-but-failed jar, then the
  // failure branches below set cookies_stale_at on the same row — the
  // resulting account is permanently stale with paradoxical "minted +
  // stale within 1s" timestamps that no consumer can reason about.
  if (liAt) { await captureCookies(); writeBan('healthy', { final_url: finalUrl }); console.log(`PASS: li_at cookie set — ${finalUrl}`); }
  else if (onCheckpoint) { writeBan('checkpoint', { final_url: finalUrl, reason: 'linkedin issued captchaV2; CapSolver AntiPerimeterX did not return usable cookies' }); const { markCookiesStale } = await import('../../dist/utils/credentials.js'); if (acct.id) await markCookiesStale(acct.id); console.log(`FAIL: linkedin checkpoint — ${finalUrl} (cookies marked stale)`); process.exitCode = 1; }
  else if (finalUrl.startsWith('chrome-error://')) { writeBan('proxy_failed', { final_url: finalUrl, reason: 'chrome-error: proxy CONNECT failed before login completed' }); console.log(`FAIL: proxy_failed — ${finalUrl}`); process.exitCode = 1; }
  // Landing back on /login (often with ?session_redirect=...) after submit
  // means credentials were silently rejected — wrong password, locked account,
  // or invalidated session. Treat as cookies-stale: same 24h skip as
  // checkpoint, so the routine cron stops draining the queue against a dead
  // login. Without this, the same account hits /login on every tick forever.
  else if (/^https:\/\/www\.linkedin\.com\/login(\/|\?|$)/.test(finalUrl)) { writeBan('checkpoint', { final_url: finalUrl, reason: 'submit returned to /login — credentials rejected or session_redirect loop' }); const { markCookiesStale } = await import('../../dist/utils/credentials.js'); if (acct.id) await markCookiesStale(acct.id); console.log(`FAIL: linkedin login bounced back — ${finalUrl} (cookies marked stale)`); process.exitCode = 1; }
  // Default: form submitted, no checkpoint URL, no chrome-error, no li_at.
  // The cookies the trajectory had don't authenticate any more — mark stale
  // so the routine cron stops re-attempting against this dead account.
  else { writeBan('checkpoint', { final_url: finalUrl, reason: 'no li_at cookie set after submit' }); const { markCookiesStale } = await import('../../dist/utils/credentials.js'); if (acct.id) await markCookiesStale(acct.id); console.log(`FAIL: no li_at cookie — ${finalUrl} (cookies marked stale)`); process.exitCode = 1; }
} catch (e) {
  // Classify the catch-tail. ERR_HTTP_RESPONSE_CODE_FAILURE on /login means
  // LinkedIn returned a 4xx/5xx at the page-load itself — fingerprint or IP
  // is being blocked at the edge before any captcha screen even renders.
  // chrome-error means proxy CONNECT failure. Both are platform-side blocks,
  // not generic "unknown".
  const finalUrl = s.page?.url?.() ?? '';
  let sig = 'unknown_error';
  const msg = e.message ?? '';
  // Order matters: HTTP-level rejections (4xx/5xx at edge) MUST classify
  // as ip_blocked even though the URL ends up at chrome-error. The worker
  // pool auto-markBurned only fires on ip_blocked, not proxy_failed —
  // misclassifying as proxy_failed leaves the burned IP in rotation.
  // ERR_TUNNEL_CONNECTION_FAILED is the actual proxy CONNECT failure.
  if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/.test(msg)) sig = 'ip_blocked';
  else if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(msg)) sig = 'proxy_failed';
  else if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
  else if (/Timeout|net::ERR_TIMED_OUT/.test(msg)) sig = 'proxy_failed';
  // Image-selection (hCaptcha tile picker), or any /checkpoint/ landing →
  // cookies-stale: solve_captcha can't drive these flows. Mark stale so the
  // routine cron skips this account for 24h instead of looping.
  else if (/\/(checkpoint|uas\/login|login\/recovery)/.test(finalUrl) || /image-selection|select.*buses|solve_captcha/i.test(msg)) { sig = 'checkpoint'; const { markCookiesStale } = await import('../../dist/utils/credentials.js'); if (acct.id) await markCookiesStale(acct.id); }
  writeBan(sig, { final_url: finalUrl, error: msg.slice(0, 200) });
  console.log('FAIL:', msg.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
