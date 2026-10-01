// One-time: log into your real Google account and export the cookies.
// Run:   node src/trajectories/google/_export_cookies.mjs
// Uses the custom Weles Chromium so Google doesn't reject with
// "This browser or app may not be secure".
import { WSession } from '../../../dist/session/wsession.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { urlMatching } from '../_shared/page/settled.mjs';

const OUT = join(homedir(), '.weles', 'google_approver_cookies.json');
mkdirSync(dirname(OUT), { recursive: true });

const s = await WSession.start({ label: 'google_cookie_export', proxy: 'none' });
const page = s.page;
const ctx = s.ctx;

console.log('[export] Opening accounts.google.com — sign in normally (2FA, phone tap, whatever).');
await page.goto('https://accounts.google.com/ServiceLogin?continue=https://myaccount.google.com/');

console.log('[export] Waiting for you to land on myaccount.google.com or mail.google.com ...');
// Closing the window before landing ends the wait with an error.
await urlMatching(page, /^https:\/\/(myaccount\.google\.com|([a-z0-9-]+\.)?mail\.google\.com)\//);

const cookies = await ctx.cookies();
const googleCookies = cookies.filter(c =>
  c.domain?.includes('google.com') || c.domain?.includes('youtube.com') || c.domain?.includes('googleusercontent.com'));
writeFileSync(OUT, JSON.stringify(googleCookies, null, 2));
console.log(`[export] Saved ${googleCookies.length} cookies to ${OUT}`);
const auth = googleCookies.filter(c => /^(SID|HSID|SSID|SAPISID|APISID|__Secure-\w+)/.test(c.name)).map(c => c.name);
console.log(`[export] Auth cookies present: ${auth.join(', ')}`);
await s.close();
