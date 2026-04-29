/**
 * Recover a locked-out GitHub account: trigger GitHub's password-reset flow,
 * claim the reset link via Resend inbound email, set a new password, persist
 * to social_accounts.metadata.password.
 *
 * Needed because the 2026-04-17 signup batch wrote passwords into metadata
 * that do not authenticate — every github_login for those accounts lands
 * back at /login silently. Manual password reset fixes this per-account.
 *
 * Uses direct egress (same reasoning as github_login) unless an override
 * env is set.
 */
import { getSocialAccount } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';\nimport { humanClickLocator } from '../../../../dist/human/mouse.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account'); process.exit(1); }
if (!acct.metadata?.email) { console.log(`FAIL: account ${acct.username} has no email`); process.exit(1); }
const email = acct.metadata.email;
const resendKey = process.env.RESEND_RECEIVING_API_KEY;
if (!resendKey) { console.log('FAIL: RESEND_RECEIVING_API_KEY not set'); process.exit(1); }
// Reset emails go to Resend inbound MX which is bound to wisentmedia.com.
// Any account whose email is on a different domain (e.g. throwaway domains
// like hubbold730.com, mailcom, tutanota) cannot have its reset link claimed
// here. Fail fast with a clear signal instead of polling 2 min for nothing.
if (!/@wisentmedia\.com$/i.test(email)) {
  try {
    const dir = join(process.cwd(), 'recordings', 'github_reset_password');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_reset_password', healthy: false, signal: 'unsupported_email_domain', error: `email ${email} is not on wisentmedia.com — Resend inbound MX won't receive reset link`, ts: new Date().toISOString() }, null, 2));
  } catch {}
  console.log(`FAIL: account ${acct.username} email ${email} not on wisentmedia.com — cannot claim reset link via Resend`);
  process.exit(1);
}

let proxyUrl;
if (process.env.PROXY_URL) proxyUrl = process.env.PROXY_URL;
else if (process.env.USE_SAVED_PROXY === '1' && acct.metadata?.proxy?.server) {
  const u = new globalThis.URL(acct.metadata.proxy.server);
  proxyUrl = `${u.protocol}//${acct.metadata.proxy.username}:${acct.metadata.proxy.password}@${u.hostname}:${u.port}`;
}

const newPassword = 'Wp' + randomBytes(9).toString('base64').replace(/[+/=]/g, '') + '!A1';
console.log(`[reset] Account: ${acct.username} (${email})`);
console.log(`[reset] Proxy: ${proxyUrl ? 'yes' : 'direct egress'}`);

const s = await WSession.start({ label: 'github_reset_password', proxy: proxyUrl });
try {
  await s.goto('https://github.com/password_reset');
  await s.wait(3);
  await s.fill('Email address', email);
  await s.wait(1);
  // Use Playwright locator for isTrusted=true (see DETECTION_ANTIPATTERNS §1).
  // GitHub renders submit as `<input name="commit" type="submit" disabled>`
  // gated by an octocaptcha class — the disabled attribute clears after the
  // OctoCaptcha challenge succeeds (or after the email field gains focus +
  // valid content depending on render flag). Wait for :not([disabled]) so we
  // don't try to click while still disabled.
  await s.page.locator('input[name="commit"]:not([disabled]), button[type="submit"]:not([disabled])').first().waitFor({ state: 'visible' }).catch(() => {});
  const SUBMIT_SELECTORS = 'input[name="commit"]:not([disabled])|input[type="submit"]:not([disabled])|button[type="submit"]:not([disabled])|button:has-text("Send password reset email"):not([disabled])|input[name="commit"]|form[action*="password_reset"] button'.split('|');
  let submit = { clicked: false };
  for (const sel of SUBMIT_SELECTORS) {
    const loc = s.page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) > 0) {
      const r = await humanClickLocator(s.page, loc).then(() => ({ clicked: true, via: sel })).catch((e) => ({ clicked: false, err: e.message?.slice(0, 100), tried: sel }));
      if (r.clicked) { submit = r; break; }
      submit = r;
    }
  }
  if (!submit.clicked) {
    // Submit the form directly via DOM. Routes a real form submit through
    // Blink (not isTrusted=false synthetic click on button).
    const formSubmitted = await s.page.evaluate(() => { const f = document.querySelector('form[action*="password_reset"], form'); if (f && typeof f.requestSubmit === 'function') { f.requestSubmit(); return true; } if (f) { f.submit(); return true; } return false; }).catch(() => false);
    if (formSubmitted) submit = { clicked: true, via: 'form.requestSubmit' };
  }
  console.log(`[reset] Submit reset request: ${JSON.stringify(submit)}`);
  if (!submit.clicked) throw new Error('no submit control on password_reset page');

  await s.wait(5);
  console.log('[reset] Polling Resend for reset email...');
  let resetUrl = null;
  for (let poll = 0; poll < 30 && !resetUrl; poll++) {
    await s.wait(4);
    const res = await fetch('https://api.resend.com/emails/receiving?limit=20', {
      headers: { Authorization: `Bearer ${resendKey}` },
    });
    if (!res.ok) { console.log(`[reset] resend list ${res.status}`); continue; }
    const emails = (await res.json()).data ?? [];
    for (const em of emails) {
      const to = (em.to ?? []).map(t => typeof t === 'string' ? t : t.email).join(',');
      if (!to.includes(email)) continue;
      if (!/github|noreply@github/i.test(em.from ?? '')) continue;
      const full = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${resendKey}` } })).json();
      const body = (full.html ?? '') + (full.text ?? '');
      const m = body.match(/https:\/\/github\.com\/password_reset\/[A-Za-z0-9_-]+/);
      if (m) { resetUrl = m[0]; break; }
    }
  }
  if (!resetUrl) throw new Error('no reset email received');
  console.log(`[reset] Reset URL: ${resetUrl.slice(0, 60)}...`);

  await s.goto(resetUrl);
  await s.wait(3);
  await s.fill('New password', newPassword);
  await s.wait(1);
  await s.fill('Confirm new password', newPassword);
  await s.wait(1);
  const submitLoc2 = s.page.locator('input[type="submit"][value*="Change" i], button[type="submit"]').first();
  const submit2 = (await submitLoc2.count()) > 0
    ? await humanClickLocator(s.page, submitLoc2).then(() => ({ clicked: true, via: 'humanClickLocator' })).catch((e) => ({ clicked: false, err: e.message?.slice(0, 100) }))
    : { clicked: false };
  console.log(`[reset] Submit new password: ${JSON.stringify(submit2)}`);
  if (!submit2.clicked) throw new Error('no submit control on password_reset/<token> page');

  await s.wait(6);
  const finalUrl = s.page.url?.() ?? '';
  const onSuccess = !finalUrl.includes('/password_reset') || /changed|success|signin/i.test(finalUrl);
  const errText = await s.page.evaluate("(()=>document.querySelector('.flash-error,[role=\"alert\"]')?.innerText?.trim()?.slice(0,200)||null)()").catch(() => null);
  if (!onSuccess && errText) throw new Error(`password change rejected: ${errText}`);
  console.log(`[reset] After change: ${finalUrl}`);

  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (url && key && acct.id) {
    const merged = { ...acct.metadata, password: newPassword, password_recorded_at: new Date().toISOString(), reset_via: 'github_reset_password' };
    const res = await fetch(`${url}/rest/v1/social_accounts?id=eq.${acct.id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: merged }),
    });
    if (!res.ok) throw new Error(`metadata patch ${res.status}`);
  }
  console.log(`PASS: password reset for ${acct.username}`);
} catch (e) {
  const dir = join(process.cwd(), 'recordings', 'github_reset_password');
  try { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'github_reset_password', healthy: false, signal: 'reset_failed', error: e.message, ts: new Date().toISOString() }, null, 2)); } catch {}
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  await s.close();
}
