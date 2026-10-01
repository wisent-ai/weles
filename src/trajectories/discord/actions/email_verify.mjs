// Discord email-verify trajectory. Drives the SPA verify flow for a freshly
// registered Discord account whose email is sitting on the Unverified state
// in User Settings. Sequence captured 1:1 from a keeper-driven demo.
//
// The inbox has no push or blocking read, so the flow never waits for mail:
//   1. Source account via getSocialAccount('discord') + persona/proxy from
//      resolveAccountSession. Start WSession.
//   2. Restore login state from metadata.discord_token via addInitScript
//      seeding localStorage.token on every discord.com document load.
//   3. Read the inbox once. When a "Verify Email Address for Discord" mail
//      sent after the last resend this account recorded is there, follow its
//      click.discord.com redirect to discord.com/verify#token=..., open it,
//      read "Email Verified" and persist metadata.email_verified_at.
//   4. Otherwise open User Settings, click Resend Verification Email, record
//      metadata.email_verify_requested_at and stop with a named error; the
//      next run finds the mail.
import { updateAccountMetadata } from '../../_shared/skarbiec/accounts.mjs';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { getReceived, listReceived, receivingConfigured } from '../../../_shared/resend-receiving.mjs';

const ACCT_USERNAME = process.env.ACCOUNT_USERNAME;
if (!receivingConfigured()) { console.log('FAIL: the wisent-integrations inbox route is not configured'); process.exit(Number('1')); }

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
  catch (e) { console.log(`[email_verify] verify-text probe err: ${e.message}`); return null; }
}

async function fetchInboxRecent() {
  return (await listReceived(10)).data;
}

async function fetchEmailBody(id) {
  const j = await getReceived(id);
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

// The verify URL from a mail already in the inbox that was sent after this
// account's last recorded resend, or null when there is none.
async function verifyUrlFromInbox() {
  const requestedAt = Date.parse(acct.metadata?.email_verify_requested_at ?? '');
  if (!requestedAt) return null;
  const candidate = (await fetchInboxRecent()).find((m) => {
    const toList = Array.isArray(m.to) ? m.to : [];
    const to = toList.map(t => typeof t === 'string' ? t : t.email).join(',');
    const subj = typeof m.subject === 'string' ? m.subject : '';
    const created = m.created_at ? Date.parse(m.created_at) : 0;
    return to.includes(email) && subj.includes('Verify') && created >= requestedAt;
  });
  if (!candidate) return null;
  const body = await fetchEmailBody(candidate.id);
  const links = body.match(/https:\/\/click\.discord\.com[^\s"<>]+/g);
  if (!links) throw new Error(`discord_email_verify: mail ${candidate.id} has no click.discord.com links`);
  for (const link of links) {
    const u = await resolveClickToVerify(link);
    if (u) return u;
  }
  throw new Error(`discord_email_verify: no link in mail ${candidate.id} resolves to discord.com/verify`);
}

try {
  await s.ctx.addInitScript(`(()=>{try{if(location.hostname.indexOf('discord')>=0){localStorage.setItem('token',JSON.stringify(${JSON.stringify(token)}))}}catch(e){}})()`);
  const verifyUrl = await verifyUrlFromInbox();
  if (!verifyUrl) {
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
    if ((await okay.count()) > 0) await humanClickLocator(s.page, okay);
    if (!acct.id) throw new Error('Discord account has no stable Skarbiec id');
    updateAccountMetadata(acct.id, { email_verify_requested_at: new Date().toISOString() });
    throw new Error(`discord_email_verify: verification mail requested for ${email}; it has not arrived yet — run email_verify again once it is in the inbox`);
  }
  console.log(`[email_verify] verify_url=${verifyUrl.slice(0, 90)}...`);

  await s.goto(verifyUrl);
  await humanIdlePause('deliberate');
  const verifiedText = await getVerifiedText(s);
  if (!verifiedText) { console.log('FAIL: "Email Verified" text not found on verify page'); process.exit(1); }
  console.log(`[email_verify] page shows: ${verifiedText}`);

  if (!acct.id) throw new Error('Discord account has no stable Skarbiec id');
  updateAccountMetadata(acct.id, { email_verified_at: new Date().toISOString() });
  console.log('[email_verify] persisted account metadata in Skarbiec');
  console.log(`PASS: ${acct.username} email verified`);
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  process.exit(1);
} finally {
  await s.close();
}
process.exit(0);
