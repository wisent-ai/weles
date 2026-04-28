import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'https://www.instagram.com/accounts/login/';
const GOAL = `fill(target="username",value=$SVC_EMAIL). fill(target="password",value=$SVC_PASSWORD). js_click(selector="button[type='submit']",text="Log in"). Wait 5 seconds. If email verification code required, check_email(email=$SVC_EMAIL,sender="instagram") for code, fill the code, click Confirm. If error "incorrect", give_up(reason="invalid credentials"). done(value="logged in").`;

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_login', proxy: proxyUrl, persona });

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

try {
  // Cookie-first: inject sessionid, navigate to /, check we land on home
  const stored = Array.isArray(acct.metadata?.cookies) ? acct.metadata.cookies : [];
  const hasSessionId = stored.some(c => c?.name === 'sessionid' && c?.value);
  if (hasSessionId) {
    const prepared = stored.filter(c => c?.name && c?.value && (c.domain || c.url)).map(c => ({ ...c, path: c.path || '/' }));
    await s.ctx.addCookies(prepared);
    await s.page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
    await s.page.waitForTimeout(3500);
    const u = s.page.url();
    if (/accounts\/suspended|accounts\/disabled/.test(u)) throw new Error(`suspended: account banned by instagram (${u})`);
    if (!/accounts\/login|accounts\/onetap|challenge|checkpoint/.test(u)) {
      console.log(`PASS: logged in (cookie-first) — ${u}`);
      await captureCookies();
      process.exit(0);
    }
    console.log(`[trajectory] cookie-first landed on ${u} — falling through to form login`);
  }
  // Direct Playwright form login. Instagram inputs use name=username/password.
  await s.page.goto(URL, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(2500);
  const userIn = s.page.locator('input[name="username"], input[aria-label*="username" i]').filter({ visible: true }).first();
  const pwIn = s.page.locator('input[name="password"], input[type="password"]').filter({ visible: true }).first();
  await userIn.waitFor({ state: 'visible' });
  await userIn.click();
  await userIn.pressSequentially(process.env.SVC_EMAIL, { delay: 25 });
  await pwIn.click();
  await pwIn.pressSequentially(process.env.SVC_PASSWORD, { delay: 25 });
  await s.page.waitForTimeout(400);
  await s.page.locator('button[type="submit"]').filter({ visible: true }).first().click();
  for (let i = 0; i < 15; i++) {
    await s.page.waitForTimeout(1000);
    if (!/\/accounts\/login\/?$/.test(s.page.url())) break;
  }
  const finalUrl = s.page.url();
  console.log(`[instagram_login] post-submit url=${finalUrl}`);
  // Check for inline error text
  const ERR_SEL = '#slfErrorAlert, [data-bloks-name*="Error"], [role="alert"]';
  const err = await s.page.evaluate((sel) => Array.from(document.querySelectorAll(sel)).map(e => e.textContent?.trim()).filter(Boolean), ERR_SEL).catch(() => []);
  if (err.length && /incorrect|wasn't recognised|wasn't recognized|password|wait a few minutes/i.test(err.join(' '))) {
    throw new Error(`invalid_credentials_or_block: ${err.join(' | ').slice(0, 150)}`);
  }
  if (/\/accounts\/login/.test(finalUrl)) throw new Error('login form did not submit / no redirect');
  if (/challenge|checkpoint|two_factor/.test(finalUrl)) throw new Error(`checkpoint at ${finalUrl}`);
  if (/accounts\/suspended|accounts\/disabled/.test(finalUrl)) throw new Error(`suspended: ${finalUrl}`);
  console.log(`PASS: logged in — ${finalUrl}`);
  await captureCookies();
} catch (e) {
  // Write a structured ban_signal so the worker doesn't fall back to
  // 'unknown_error'. instagram_login often fails on the post-submit verify-
  // email page; surface the final URL so the operator can see whether it
  // hit a captcha, verify wall, or just timed out.
  try {
    const dir = join(process.cwd(), 'recordings', 'instagram_login');
    mkdirSync(dir, { recursive: true });
    const finalUrl = s.page?.url?.() ?? '';
    // Suspended/disabled is the cleanest classification for an instagram
    // account that landed at /accounts/suspended/ or /accounts/disabled/ —
    // the login itself worked, the account is banned. Falling through to
    // 'action_failed' hides the actual state from rerun_failed.mjs which
    // would then pointlessly retry.
    // Order matters: HTTP-level rejection (4xx/5xx at edge) lands the page on
    // chrome-error://chromewebdata/ — same URL as a proxy CONNECT failure but
    // categorically different. ip_blocked → worker.markBurned rotates the
    // proxy host; action_failed leaves the burned IP in rotation. Match the
    // linkedin_login / twitter_login classifier ordering.
    const msg = e.message ?? '';
    let sig;
    if (/\/accounts\/suspended|\/accounts\/disabled/.test(finalUrl)) sig = 'suspended';
    else if (/\/checkpoint|\/challenge|\/two_factor/.test(finalUrl)) sig = 'checkpoint';
    else if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/.test(msg)) sig = 'ip_blocked';
    else if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(msg)) sig = 'proxy_failed';
    else if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
    else sig = 'action_failed';
    writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({
      account_id: acct.id, username: acct.username, action: 'instagram_login',
      signal: sig, healthy: false,
      details: { final_url: finalUrl, reason: e.message?.slice(0, 200) ?? 'no message' },
      ts: new Date().toISOString(),
    }, null, 2));
    // If the platform suspended the account, flip is_active=false so
    // getSocialAccount stops picking it. Same pattern as discord_login.
    if (sig === 'suspended') {
      const { deactivateAccount } = await import('../../dist/account/state.js');
      await deactivateAccount(acct.id, acct.metadata, 'INSTAGRAM_SUSPENDED');
    }
  } catch {}
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
