import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';
import { detectRedditBanSignals } from '../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'https://www.reddit.com/login';
const GOAL = `Fill username/email with $SVC_EMAIL and password with $SVC_PASSWORD. Click Log In or Sign In. Wait for redirect. done(value="logged in").`;

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

async function wipeStoredProxy(accountId) {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !key || !accountId) return;
  try {
    const r = await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${accountId}&select=metadata`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json();
    const meta = rows?.[0]?.metadata ?? {};
    const { proxy: _drop, ...rest } = meta;
    await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${accountId}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: rest }),
    });
    console.log(`[proxy-rotate] cleared stored proxy for account ${accountId} — next attempt will re-roll`);
  } catch (e) { console.log('[proxy-rotate] err:', e.message); }
}

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_login', proxy: proxyUrl, persona });
let banSignal = null;
try {
  await s.goto(URL);

  // Early exit on IP-level network-security block: Reddit's edge has flagged the
  // exit IP. No point running the vision agent against a blocked page; wipe the
  // stored proxy so the next retry rolls a fresh one.
  const earlySignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (earlySignal?.signal === 'ip_blocked') {
    banSignal = earlySignal;
    console.log(`[ban-signal] ${earlySignal.signal} (early) — rotating proxy`);
    await wipeStoredProxy(acct.id);
    console.log('FAIL: reddit edge blocked this exit IP; cleared stored proxy for next retry');
    process.exitCode = 1;
  } else {
    const result = await execute(s, `Open ${URL}. ${GOAL}`, {
      envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
      flowName: 'reddit_login',
    });
    banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch((e) => ({ healthy: false, signal: 'unknown_error', details: { detector_error: e.message } }));
    console.log(`[ban-signal] ${banSignal.signal} (${JSON.stringify(banSignal.details).slice(0, 200)})`);
    if (banSignal?.signal === 'ip_blocked') await wipeStoredProxy(acct.id);
    console.log('PASS:', result.value);
  }
} catch (e) {
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
  if (banSignal?.signal === 'ip_blocked') await wipeStoredProxy(acct.id);
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = join(process.cwd(), 'recordings', 'reddit_login');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
