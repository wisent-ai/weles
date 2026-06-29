// Drive the apple_asc keeper through Apple ID login, let the user complete
// 2FA + Trust manually in the browser, then navigate to Turbot and extract
// the App Store Connect rejection details.

import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const APP_ID = process.env.APP_ID || '6502873271';
const SESSION = process.env.SESSION || 'apple_asc';
const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
const DASHBOARD_TIMEOUT_MS = 5 * 60 * 1000;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function getAppleAccount() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?platform=eq.apple&is_active=eq.true&select=username,metadata&order=created_at.desc&limit=1`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`supabase fetch failed: ${res.status}`);
  const rows = await res.json();
  if (!rows.length) throw new Error('no active apple account');
  const m = rows[0].metadata || {};
  return { username: rows[0].username, email: m.email, password: m.password };
}

function sendCmd(cmd) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(SOCK);
    let buf = '';
    conn.on('connect', () => conn.write(JSON.stringify(cmd) + '\n'));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      try {
        const res = JSON.parse(buf.slice(0, nl));
        conn.end();
        resolve(res);
      } catch (e) {
        conn.end();
        reject(e);
      }
    });
    conn.on('error', reject);
    setTimeout(() => { try { conn.end(); } catch {} reject(new Error('keeper socket timeout')); }, 60000);
  });
}

async function waitFor(condition, msg, timeoutMs = 30000, intervalMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    console.log(msg);
    await sleep(intervalMs);
  }
  throw new Error(`timeout: ${msg}`);
}

async function currentUrl() {
  const r = await sendCmd({ action: 'url' });
  return r.ok ? r.url : '';
}

async function evalJs(js) {
  const r = await sendCmd({ action: 'eval', js });
  return r.ok ? r.result : null;
}

async function nav(url) {
  const r = await sendCmd({ action: 'nav', url });
  console.log(`[keeper] nav -> ${r.ok ? r.url : r.error}`);
  if (!r.ok) throw new Error(r.error);
  return r.url;
}

async function fill(selector, text) {
  const r = await sendCmd({ action: 'fill', selector, text });
  console.log(`[keeper] fill ${selector} -> ${r.ok ? 'ok' : r.error}`);
  if (!r.ok) throw new Error(r.error);
}

async function iframeFill(selector, text) {
  const r = await sendCmd({ action: 'iframe_fill', iframe: 'idmsa.apple.com', selector, text });
  console.log(`[keeper] iframe_fill ${selector} -> ${r.ok ? 'ok' : r.error}`);
  if (!r.ok) throw new Error(r.error);
}

async function click(selector) {
  const r = await sendCmd({ action: 'click', selector });
  console.log(`[keeper] click ${selector} -> ${r.ok ? 'ok' : r.error}`);
  if (!r.ok) throw new Error(r.error);
}

async function iframeClick(selector) {
  const r = await sendCmd({ action: 'iframe_click', iframe: 'idmsa.apple.com', selector });
  console.log(`[keeper] iframe_click ${selector} -> ${r.ok ? 'ok' : r.error}`);
  if (!r.ok) throw new Error(r.error);
}

async function screenshot(name) {
  const r = await sendCmd({ action: 'screenshot' });
  console.log(`[keeper] screenshot ${name} -> ${r.ok ? r.path : r.error}`);
  return r;
}

const acct = await getAppleAccount();
if (!acct.email || !acct.password) throw new Error('apple account missing email or password');
console.log(`[keeper] using account: ${acct.username} (${acct.email})`);

// Step 1: make sure we are on the App Store Connect login page.
const currentU = await currentUrl();
if (!currentU.includes('appstoreconnect.apple.com/login')) {
  console.log('[keeper] navigating to ASC login');
  await nav('https://appstoreconnect.apple.com/login?targetUrl=%2Fapps');
  await sleep(4000);
}

// Step 2: fill email inside the Apple ID auth iframe and continue.
await iframeFill('input#account_name_text_field', acct.email);
await sleep(1000);
await iframeClick('button#sign-in');

// Step 3: wait for password field and fill it.
await sleep(3000);
await screenshot('password_prompt');
await iframeFill('input#password_text_field', acct.password);
await sleep(1000);
await iframeClick('button#sign-in');

// Step 4: wait for user to complete 2FA + Trust.
console.log('[keeper] email+password submitted. Please complete 2FA and click Trust in the browser. I will wait.');
await waitFor(async () => {
  const u = await currentUrl();
  return u.includes('appstoreconnect.apple.com') && !u.includes('/login') && !u.includes('idmsa');
}, 'waiting for App Store Connect dashboard after 2FA/Trust...', DASHBOARD_TIMEOUT_MS, 3000);

// Step 5: navigate to Turbot distribution/review page.
const reviewUrl = `https://appstoreconnect.apple.com/apps/${APP_ID}/distribution`;
console.log(`[keeper] navigating to ${reviewUrl}`);
await nav(reviewUrl);
await sleep(6000);

// Step 6: extract review info.
const info = await evalJs(`(() => {
  const text = document.body?.innerText || '';
  const buttons = Array.from(document.querySelectorAll('button')).map(b => (b.textContent || '').trim()).filter(t => t.length);
  const links = Array.from(document.querySelectorAll('a')).map(a => (a.textContent || '').trim()).filter(t => t.length);
  return { text, buttons, links };
})()`);

if (!info) throw new Error('failed to extract page info');

const relevantTerms = ['rejected','rejection','unresolved','issues','guideline','resolution','review','pending','waiting for review','app review','binary rejected','metadata rejected','age rating','content rights','minor','18+'];
const lower = info.text.toLowerCase();
const snippets = [];
for (const term of relevantTerms) {
  let idx = lower.indexOf(term);
  while (idx !== -1) {
    snippets.push(info.text.slice(Math.max(0, idx - 120), Math.min(info.text.length, idx + 250)).replace(/\s+/g, ' ').trim());
    idx = lower.indexOf(term, idx + term.length);
    if (snippets.length >= 30) break;
  }
  if (snippets.length >= 30) break;
}

console.log('\n=== PAGE TEXT (first 4000 chars) ===');
console.log(info.text.slice(0, 4000));
console.log('\n=== BUTTONS ===');
console.log(JSON.stringify(info.buttons.slice(0, 50), null, 2));
console.log('\n=== RELEVANT SNIPPETS ===');
console.log(JSON.stringify([...new Set(snippets)], null, 2));

await screenshot('turbot_review');
console.log('[keeper] DONE');
process.exit(0);
