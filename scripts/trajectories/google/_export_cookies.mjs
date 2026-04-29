// One-time: log into your real Google account and export the cookies.
// Run:   node scripts/trajectories/google/_export_cookies.mjs
// Uses the custom Weles Chromium so Google doesn't reject with
// "This browser or app may not be secure".
import { WSession } from '../../../dist/session/wsession.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

const OUT = join(homedir(), '.weles', 'google_approver_cookies.json');
mkdirSync(dirname(OUT), { recursive: true });

const s = await WSession.start({ label: 'google_cookie_export', proxy: 'none' });
const page = s.page;
const ctx = s.ctx;

console.log('[export] Opening accounts.google.com — sign in normally (2FA, phone tap, whatever).');
await page.goto('https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/');

console.log('[export] Waiting for you to land on myaccount.google.com or mail.google.com ...');
const isLoggedIn = (u) => {
  try { const h = new URL(u).hostname; return h === 'myaccount.google.com' || h.endsWith('.mail.google.com') || h === 'mail.google.com'; }
  catch { return false; }
};
const deadline = Date.now() + 10 * 60_000;
while (Date.now() < deadline) {
  if (isLoggedIn(page.url())) break;
  await new Promise(r => setTimeout(r, 1500));
}

const url = page.url();
if (!isLoggedIn(url)) {
  console.log(`[export] Timed out on ${url}. Finish login within 10 min and re-run.`);
  await s.close(); process.exit(1);
}

const cookies = await ctx.cookies();
const googleCookies = cookies.filter(c =>
  c.domain?.includes('google.com') || c.domain?.includes('youtube.com') || c.domain?.includes('googleusercontent.com'));
writeFileSync(OUT, JSON.stringify(googleCookies, null, 2));
console.log(`[export] Saved ${googleCookies.length} cookies to ${OUT}`);
const auth = googleCookies.filter(c => /^(SID|HSID|SSID|SAPISID|APISID|__Secure-\w+)/.test(c.name)).map(c => c.name);
console.log(`[export] Auth cookies present: ${auth.join(', ')}`);
await s.close();
