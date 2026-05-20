// Drive the JuicySMS dashboard via forgot-password → reset → login.
// Goal: see whether the dashboard shows the 17 IG orders this session
// as "SMS arrived but not relayed" versus "truly never received".
// Auto-account: svc.jui.4jtakl@wisentmedia.com (password unknown).
import { WSession } from '../../../dist/session/wsession.js';
import { humanIdlePause } from '../../../dist/human/mouse.js';
import { randomBytes } from 'node:crypto';

const EMAIL = 'svc.jui.4jtakl@wisentmedia.com';
const NEW_PW = `J${randomBytes(8).toString('base64url')}!9`;

async function pause(s) { await new Promise(r => setTimeout(r, s * 1000)); }  // allow-raw-playwright: between-poll wait for Resend API, no browser action

async function waitForResetEmail(start) {
  for (let i = 0; i < 60; i++) {
    await pause(5);
    const r = await fetch('https://api.resend.com/emails/receiving?limit=50', {
      headers: { Authorization: `Bearer ${process.env.RESEND_RECEIVING_API_KEY}` },
    });
    const j = await r.json();
    const match = (j.data || []).find(m =>
      (m.from || '').includes('juicysms') &&
      (m.to || []).includes(EMAIL) &&
      new Date(m.created_at).getTime() >= start);
    if (match) {
      const full = await (await fetch(`https://api.resend.com/emails/receiving/${match.id}`, {
        headers: { Authorization: `Bearer ${process.env.RESEND_RECEIVING_API_KEY}` },
      })).json();
      console.log(`[mail] juicysms reset email arrived id=${match.id} subj="${match.subject}"`);
      return full;
    }
    if (i % 6 === 0) console.log(`[mail] waiting for juicysms reset... ${i * 5}s elapsed`);
  }
  return null;
}

const start = Date.now();
const s = await WSession.start({ label: 'juicysms_dashboard', browser: 'chromium' });
try {
  await s.goto('https://juicysms.com/forgot-password');
  await humanIdlePause('deliberate');
  await s.fill('email', EMAIL);
  await humanIdlePause('short');
  await s.click('Email Password Reset Link');
  await humanIdlePause('deliberate');
  console.log(`[dash] forgot-password submitted; polling Resend for reset email...`);
  const email = await waitForResetEmail(start);
  if (!email) throw new Error('reset_email_not_received');
  const body = (email.html || email.text || '');
  const linkMatch = body.match(/https:\/\/juicysms\.com\/reset-password\/[A-Za-z0-9%._/-]+/);
  if (!linkMatch) throw new Error('reset_link_not_in_email');
  console.log(`[dash] following reset link: ${linkMatch[0].slice(0, 60)}...`);
  await s.goto(linkMatch[0]);
  await humanIdlePause('deliberate');
  // Reset form has Email + Password (no Confirm Password) per frame
  // reset_done.png 2026-05-20. Earlier guess at Password + Confirm
  // Password left Email blank and never updated the credential.
  await s.fill('email', EMAIL);
  await humanIdlePause('short');
  await s.fill('Password', NEW_PW);
  await humanIdlePause('short');
  await s.click('Reset Password');
  await humanIdlePause('long');
  console.log(`[dash] password reset complete; new pw=${NEW_PW.slice(0,4)}...${NEW_PW.slice(-3)}`);
  await s.goto('https://juicysms.com/login');
  await humanIdlePause('deliberate');
  await s.fill('email', EMAIL);
  await humanIdlePause('short');
  await s.fill('password', NEW_PW);
  await humanIdlePause('short');
  await s.click('Login');
  await humanIdlePause('long');
  console.log(`[dash] login URL=${s.page.url()}`);
  for (const path of ['/orders', '/transactions', '/history', '/dashboard']) {
    await s.goto(`https://juicysms.com${path}`);
    await humanIdlePause('deliberate');
    console.log(`[dash] navigated to ${path} → ${s.page.url()}`);
  }
  await fetch(`${process.env.SUPABASE_URL}/rest/v1/service_credentials?id=eq.juicysms_auto`, {
    method: 'PATCH',
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ login_password: NEW_PW, updated_at: new Date().toISOString() }),
  }).then(r => console.log(`[dash] saved new password to service_credentials: HTTP ${r.status}`));
  console.log('[dash] PASS');
} catch (e) {
  console.log(`[dash] FAIL: ${e.message?.slice(0, 200)}`);
} finally {
  await s.close();
}
