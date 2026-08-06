// Discord email-verify trajectory. Drives the SPA verify flow end-to-end
// for a freshly registered Discord account whose email is sitting on the
// Unverified state in User Settings. Verified working via keeper on
// 2026-05-19 for account rileydawson221194 — sequence captured here 1:1
// from the keeper-driven demo.
//
// Sequence:
//   1. Source account via getSocialAccount('discord') + persona/proxy from
//      resolveAccountSession. Start WSession.
//   2. Restore login state from metadata.discord_token via addInitScript
//      seeding localStorage.token on every discord.com document load.
//   3. Navigate /channels/@me.
//   4. Open User Settings (gear icon bottom-left), click Resend
//      Verification Email button, dismiss the confirmation modal.
//   5. Poll Resend inbox every 5s for the latest "Verify Email Address
//      for Discord" message to the account's email. Time out at TIMEOUT_S.
//   6. Extract the verify URL by following each click.discord.com
//      tracking redirect and matching one that lands on
//      discord.com/verify#token=...
//   7. Navigate the WSession to the verify URL.
//   8. Wait for the "Email Verified!" text on the page.
//   9. Persist metadata.email_verified_at = ISO timestamp.

import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { readScopedSecret } from '../../../_shared/scoped-secrets.mjs';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
const TIMEOUT_S = parseInt(process.env.DISCORD_EMAIL_VERIFY_TIMEOUT || '90', 10);
const RESEND_KEY = readScopedSecret('resendReceiving', 'api_key');
if (!RESEND_KEY) { console.log('FAIL: exact Resend receiving grant unavailable'); process.exit(Number('1')); }

const acct = ACCT_USERNAME
  ? await getSocialAccount('discord', { username: ACCT_USERNAME })
  : await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no discord account'); process.exit(1); }
const email = acct.metadata?.email;
const token = acct.metadata?.discord_token;
if (!email) { console.log(`FAIL: ${acct.username} metadata.email missing`); process.exit(1); }
if (!token) { console.log(`FAIL: ${acct.username} metadata.discord_token missing`); process.exit(1); }

async function getVerifiedText(s) {
  try { return await s.page.locator('text=Email Verified').first().textContent(); }
  catch (e) { console.log(`[email_verify] verify-text probe err: ${e.message?.slice(0, 80)}`); return null; }
}

async function fetchInboxRecent(key) {
  const r = await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${key}` } });
  const j = await r.json();
  if (!j || !Array.isArray(j.data)) throw new Error(`resend inbox shape unexpected: ${JSON.stringify(j).slice(0, 120)}`);
  return j.data;
}

async function fetchEmailBody(key, id) {
  const r = await fetch(`https://api.resend.com/emails/receiving/${id}`, { headers: { Authorization: `Bearer ${key}` } });
  const j = await r.json();
  const body = j?.html ?? j?.text;
  if (!body) throw new Error(`resend email ${id} has no html/text`);
  return body;
}

async function resolveClickToVerify(link) {
  const head = await fetch(link, { redirect: 'manual' });
  const loc = head.headers.get('location');
  if (loc && loc.includes('discord.com/verify#token=')) return loc;
  return null;
}

const opts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_email_verify', proxy: opts.proxyUrl, persona: opts.persona, targetHost: 'discord.com' });
console.log(`[email_verify] account=${acct.username} email=${email}`);

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  await s.goto('https://discord.com/channels/@me');
  await humanIdlePause('deliberate');

  const gear = s.page.locator('button[aria-label="User Settings"]').first();
  await humanClickLocator(s.page, gear);
  await humanIdlePause('deliberate');

  const resend = s.page.locator('button').filter({ hasText: 'Resend Verification Email' }).first();
  if ((await resend.count()) === 0) {
    console.log('[email_verify] no Resend button on My Account — email may already be verified');
    process.exit(0);
  }
  await humanClickLocator(s.page, resend);
  await humanIdlePause('deliberate');
  const okay = s.page.locator('button').filter({ hasText: 'Okay' }).first();
  if ((await okay.count()) > 0) {
    try { await humanClickLocator(s.page, okay); }
    catch (e) { console.log(`[email_verify] okay click err: ${e.message?.slice(0, 80)}`); }
  }
  console.log('[email_verify] resend triggered, polling Resend inbox...');

  const since = Date.now();
  let verifyUrl = null;
  // retry-allowed: SMTP delivery + Resend ingestion latency, bounded.
  for (let i = 0; i < Math.ceil(TIMEOUT_S / 5); i++) {
    await new Promise(r => setTimeout(r, 5000)); // allow-raw-playwright: Resend polling cadence
    let inbox = null;
    try { inbox = await fetchInboxRecent(RESEND_KEY); }
    catch (e) { console.log(`[email_verify] inbox fetch err: ${e.message?.slice(0, 100)}`); continue; }
    const candidate = inbox.find(m => {
      const toList = Array.isArray(m.to) ? m.to : [];
      const to = toList.map(t => typeof t === 'string' ? t : t.email).join(',');
      const subj = typeof m.subject === 'string' ? m.subject : '';
      const created = m.created_at ? Date.parse(m.created_at) : 0;
      return to.includes(email) && subj.includes('Verify') && created > since - 60_000;
    });
    if (!candidate) { console.log(`[email_verify] poll ${i + 1}: no new verify email yet`); continue; }
    let body = null;
    try { body = await fetchEmailBody(RESEND_KEY, candidate.id); }
    catch (e) { console.log(`[email_verify] body fetch err: ${e.message?.slice(0, 100)}`); continue; }
    const links = body.match(/https:\/\/click\.discord\.com[^\s"<>]+/g);
    if (!links) { console.log(`[email_verify] candidate ${candidate.id} has no click.discord.com links`); continue; }
    for (const link of links) {
      try {
        const u = await resolveClickToVerify(link);
        if (u) { verifyUrl = u; break; }
      } catch (e) { console.log(`[email_verify] link resolve err: ${e.message?.slice(0, 80)}`); }
    }
    if (verifyUrl) break;
  }
  if (!verifyUrl) { console.log('FAIL: verify URL not received within timeout'); process.exit(1); }
  console.log(`[email_verify] verify_url=${verifyUrl.slice(0, 90)}...`);

  await s.goto(verifyUrl);
  await humanIdlePause('deliberate');
  const verifiedText = await getVerifiedText(s);
  if (!verifiedText) { console.log('FAIL: "Email Verified" text not found on verify page'); process.exit(1); }
  console.log(`[email_verify] page shows: ${verifiedText}`);

  const supaUrl = process.env.WELES_DATABASE_URL;
  const supaKey = process.env.WELES_DATABASE_TOKEN;
  if (supaUrl && supaKey) {
    const cur = await (await fetch(`${supaUrl}/rest/v1/social_accounts?platform=eq.discord&username=eq.${encodeURIComponent(acct.username)}&select=id,metadata`, { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } })).json();
    if (cur && cur[0]) {
      const prev = cur[0].metadata && typeof cur[0].metadata === 'object' ? cur[0].metadata : {};
      const merged = { ...prev, email_verified_at: new Date().toISOString() };
      await fetch(`${supaUrl}/rest/v1/social_accounts?id=eq.${cur[0].id}`, { method: 'PATCH', headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ metadata: merged }) });
      console.log('[email_verify] persisted metadata.email_verified_at');
    }
  }
  console.log(`PASS: ${acct.username} email verified`);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close();
}
process.exit(0);
