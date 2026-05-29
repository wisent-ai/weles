// Discord accept-friend-request trajectory. LIGHT_ENGAGEMENT tier per
// lifecycle.ts. Surfaces inbound friend requests on /channels/@me ->
// Pending tab and clicks the green Accept button per row up to limit.
//
// Env vars:
//   ACCEPT_LIMIT — max requests to accept per run (default 3).
//
// Sequence:
//   1. Source account, start WSession, addInitScript-inject discord_token.
//   2. Navigate /channels/@me.
//   3. Click Pending tab on the Friends panel.
//   4. For each row up to ACCEPT_LIMIT, find the Accept button, click it.
//   5. Append entry to metadata.friend_requests_accepted[] per success.

import { WSession } from '../../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { getSocialAccount, resolveAccountSession } from '../../../../../dist/utils/credentials.js';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const ACCEPT_LIMIT = parseInt(process.env.ACCEPT_LIMIT || '3', 10);

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no discord account'); process.exit(1); }
const token = acct.metadata?.discord_token;
if (!token) { console.log(`FAIL: ${acct.username} metadata.discord_token missing`); process.exit(1); }

const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_accept_friend_request', proxy: opts.proxyUrl, persona: opts.persona, targetHost: 'discord.com' });
console.log(`[accept_friend] account=${acct.username} limit=${ACCEPT_LIMIT}`);

async function fail(msg) {
  console.log(`FAIL: ${msg}`);
  try { await s.page.screenshot({ path: `.work/accept_friend_request/fail_${Date.now()}.png` }); } catch (e) { console.log(`[accept_friend] screenshot err: ${e.message?.slice(0, 80)}`); }
  await s.close();
  process.exit(1);
}

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto('https://discord.com/channels/@me');
  // Wait for the SPA gateway-hydration splash ("DID YOU KNOW: ...") to
  // clear by waiting for the bottom-left User Settings gear button —
  // it only appears once the user-popout has rendered.
  try { await s.page.locator('button[aria-label="User Settings"]').first().waitFor({ state: 'visible' }); }
  catch (e) { await fail(`SPA did not finish hydrating: ${e.message?.slice(0, 80)}`); }
  await humanIdlePause('short');

  // Tab text may include a count badge like "Pending (2)" — match prefix.
  const pendingTab = s.page.locator('div, button, [role=tab]').filter({ hasText: /^Pending(\s|\(|$)/ }).first();
  if ((await pendingTab.count()) === 0) { await fail('Pending tab not found'); }
  await humanClickLocator(s.page, pendingTab);
  await humanIdlePause('deliberate');

  const accepted = [];
  // retry-allowed: per-row sequential Accept click; bounded by ACCEPT_LIMIT.
  for (let i = 0; i < ACCEPT_LIMIT; i++) {
    const acceptBtn = s.page.locator('button[aria-label*="Accept"]').first();
    if ((await acceptBtn.count()) === 0) { console.log(`[accept_friend] no more pending requests (accepted ${accepted.length})`); break; }
    // Try to capture the username adjacent to the button before clicking.
    let target = null;
    try {
      target = await acceptBtn.evaluate(b => { // allow-raw-playwright: read-only DOM walk to find adjacent username
        const row = b.closest('li, [class*="peopleListItem"], [class*="friend"]');
        if (!row) return null;
        const u = row.querySelector('[class*="username"], [class*="displayName"]');
        return u ? (u.textContent || '').trim() : null;
      });
    } catch (e) { console.log(`[accept_friend] target read err: ${e.message?.slice(0, 80)}`); }
    await humanClickLocator(s.page, acceptBtn);
    await humanIdlePause('deliberate');
    accepted.push({ target: target || `<unknown ${i}>`, at: new Date().toISOString() });
    console.log(`[accept_friend] accepted ${i + 1}: ${target || '?'}`);
  }
  if (accepted.length === 0) { console.log(`PASS: ${acct.username} no pending requests to accept`); process.exit(0); }

  const supaUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (supaUrl && supaKey) {
    const cur = await (await fetch(`${supaUrl}/rest/v1/social_accounts?platform=eq.discord&username=eq.${encodeURIComponent(acct.username)}&select=id,metadata`, { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } })).json();
    if (cur && cur[0]) {
      const prev = cur[0].metadata && typeof cur[0].metadata === 'object' ? cur[0].metadata : {};
      const list = Array.isArray(prev.friend_requests_accepted) ? prev.friend_requests_accepted : [];
      list.push(...accepted);
      const merged = { ...prev, friend_requests_accepted: list };
      await fetch(`${supaUrl}/rest/v1/social_accounts?id=eq.${cur[0].id}`, { method: 'PATCH', headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ metadata: merged }) });
      console.log('[accept_friend] persisted metadata.friend_requests_accepted[]');
    }
  }
  console.log(`PASS: ${acct.username} accepted ${accepted.length} request(s)`);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close();
}
process.exit(0);
