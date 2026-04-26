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
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'instagram_login',
  });
  console.log('PASS:', result.value);
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
    let sig;
    if (/\/accounts\/suspended|\/accounts\/disabled/.test(finalUrl)) sig = 'suspended';
    else if (/\/checkpoint|\/challenge|\/two_factor/.test(finalUrl)) sig = 'checkpoint';
    else sig = 'action_failed';
    writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({
      account_id: acct.id, username: acct.username, action: 'instagram_login',
      signal: sig, healthy: false,
      details: { final_url: finalUrl, reason: e.message?.slice(0, 200) ?? 'no message' },
      ts: new Date().toISOString(),
    }, null, 2));
  } catch {}
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
