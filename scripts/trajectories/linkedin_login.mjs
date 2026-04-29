import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { CaptchaSolver } from '../../dist/captcha/solver.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanIdlePause } from '../../dist/human/mouse.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'linkedin_login', proxy: proxyUrl, persona });

async function captureCookies() {
  if (!acct.id) return;
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !key) return;
  try {
    const cookies = await s.ctx.cookies();
    const r = await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${acct.id}&select=metadata`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json();
    const merged = { ...(rows?.[0]?.metadata ?? {}), cookies };
    await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${acct.id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: merged }),
    });
    console.log(`[cookie-capture] refreshed ${cookies.length} cookies for account ${acct.id}`);
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
  await s.page.goto('https://www.linkedin.com/login', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(2500);
  // Modern LinkedIn login: visible inputs use autocomplete="webauthn" (passkey
  // hint) + current-password. Legacy #username / [name=session_key] selectors
  // are gone. Two duplicate input copies exist — only the visible one accepts
  // fill. Use pressSequentially (per-keystroke events) so React's controlled-
  // input state updates; locator.fill sets DOM value but skips React onChange.
  const usernameSel = 'input#username, input[name="session_key"], input[autocomplete="username"], input[type="text"][autocomplete="webauthn"], input[type="email"]';
  const passwordSel = 'input#password, input[name="session_password"], input[type="password"][autocomplete="current-password"]';
  // Drive both inputs via JS focus + Playwright keyboard.type. locator.click
  // on either input hangs the full default timeout (LinkedIn intercepts the
  // click during scroll-into-view). JS focus directs keystrokes correctly
  // without going through the click pipeline.
  await s.page.locator(usernameSel).filter({ visible: true }).first().waitFor({ state: 'visible' });
  await s.page.evaluate(() => document.querySelector('input#username, input[name="session_key"]')?.focus());
  await humanIdlePause('short');
  await humanType(s.page, process.env.SVC_EMAIL ?? '');
  await humanIdlePause('short');
  await s.page.evaluate(() => document.querySelector('input#password, input[name="session_password"]')?.focus());
  await humanIdlePause('short');
  await humanType(s.page, process.env.SVC_PASSWORD ?? '');
  await humanIdlePause('short');
  // LinkedIn's submit is type='submit' inside a real <form> — locator.click
  // hangs the full default click-timeout because the click event registers
  // but Playwright's navigation-wait never resolves (LinkedIn returns the
  // /uas/login-submit response that the SPA consumes in-place rather than
  // navigating). Drive the form's native submit instead — the response
  // listener captures the result and we re-read URL + cookies after.
  await s.page.evaluate(() => { const f = document.querySelector('form.login__form, form[action*="login-submit"], form'); if (f && typeof f.requestSubmit === 'function') f.requestSubmit(); else if (f) f.submit(); }).catch(() => {});
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
  await captureCookies();
  if (liAt) { writeBan('healthy', { final_url: finalUrl }); console.log(`PASS: li_at cookie set — ${finalUrl}`); }
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
