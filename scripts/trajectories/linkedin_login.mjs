import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';
import { CaptchaSolver } from '../../dist/captcha/solver.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Both /login and /uas/login return ERR_HTTP_RESPONSE_CODE_FAILURE (4xx/5xx
// at the edge) from many proxy IPs when accessed directly — LinkedIn hardens
// those paths against bot signals before any captcha. /feed/ accepts the
// same proxies and 302-redirects unauthed sessions to /uas/login organically.
// The login form is identical at the redirect target.
const URL = 'https://www.linkedin.com/feed/';
const GOAL = `Fill "session_key" with $SVC_EMAIL. Fill "session_password" with $SVC_PASSWORD. Click "Sign in". Wait 5 seconds. If captcha, solve_captcha(). If a "Verify your email" page appears requesting a verification code, check_email() to retrieve the 6-digit code from LinkedIn and fill it. done(value="logged in").`;

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
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'linkedin_login',
  });
  console.log('agent done:', result.value);
  // Validate auth + try CapSolver PerimeterX bypass on checkpoint pages.
  let cookies = await s.ctx.cookies();
  let liAt = cookies.find(c => c.name === 'li_at' && c.value);
  let finalUrl = s.page.url?.() ?? '';
  let title = await s.page.title?.().catch(() => '') ?? '';
  let onCheckpoint = /\/(checkpoint|uas\/login|login\/recovery)/.test(finalUrl) || /Security Verification/.test(title);

  if (!liAt && onCheckpoint) {
    console.log(`[linkedin_login] on checkpoint — invoking CapSolver AntiPerimeterX`);
    const ua = await s.page.evaluate(() => navigator.userAgent).catch(() => '');
    const px = await new CaptchaSolver().solvePerimeterX(finalUrl, ua, cookies.filter(c => /linkedin\.com$/.test(c.domain ?? '')).map(c => ({ name: c.name, value: c.value, domain: c.domain })));
    if (px && px.length) {
      await s.ctx.addCookies(px.map(c => ({ ...c, domain: c.domain ?? '.linkedin.com', path: c.path ?? '/' }))).catch(e => console.log('[linkedin_login] addCookies err:', e.message));
      await s.page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await s.page.waitForTimeout(3000);
      cookies = await s.ctx.cookies();
      liAt = cookies.find(c => c.name === 'li_at' && c.value);
      finalUrl = s.page.url?.() ?? '';
      title = await s.page.title?.().catch(() => '') ?? '';
      onCheckpoint = /\/(checkpoint|uas\/login|login\/recovery)/.test(finalUrl) || /Security Verification/.test(title);
      console.log(`[linkedin_login] post-bypass: li_at=${!!liAt} url=${finalUrl}`);
    }
  }
  await captureCookies();
  if (liAt) { writeBan('healthy', { final_url: finalUrl }); console.log(`PASS: li_at cookie set — ${finalUrl}`); }
  else if (onCheckpoint) { writeBan('checkpoint', { final_url: finalUrl, reason: 'linkedin issued captchaV2; CapSolver AntiPerimeterX did not return usable cookies' }); console.log(`FAIL: linkedin checkpoint — ${finalUrl}`); process.exitCode = 1; }
  else if (finalUrl.startsWith('chrome-error://')) { writeBan('proxy_failed', { final_url: finalUrl, reason: 'chrome-error: proxy CONNECT failed before login completed' }); console.log(`FAIL: proxy_failed — ${finalUrl}`); process.exitCode = 1; }
  else { writeBan('action_failed', { final_url: finalUrl, reason: 'no li_at cookie present after agent done()' }); console.log(`FAIL: no li_at cookie — ${finalUrl}`); process.exitCode = 1; }
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
  writeBan(sig, { final_url: finalUrl, error: msg.slice(0, 200) });
  console.log('FAIL:', msg.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
