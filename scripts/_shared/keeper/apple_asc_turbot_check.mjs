// Inspect Turbot rejection details through an already authenticated apple_asc keeper.
// Authentication is delegated exclusively to an explicitly authorized apple_login run.

import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const APP_ID = process.env.APP_ID || '6502873271';
const SESSION = process.env.SESSION || 'apple_asc';
const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');

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

async function assertAuthenticatedSession() {
  const url = await currentUrl();
  const loginUrl = /idmsa\.apple\.com|appleid\.apple\.com|\/login(?:[/?#]|$)|signin/i.test(url || '');
  const authPrompt = await evalJs(`(() => {
    const selector = 'iframe[src*="idmsa.apple.com"], iframe[src*="appleid.apple.com"], #account_name_text_field, #password_text_field, input[type="password"], input[aria-label*="digit"], input[aria-label*="Digit"], input[type="tel"][maxlength="1"]';
    const text = document.body?.innerText || '';
    return Boolean(document.querySelector(selector)) || /Two-Factor Authentication|verification code sent to your Apple devices/i.test(text);
  })()`);
  if (loginUrl || authPrompt) {
    throw new Error('FAIL_CLOSED: Apple login/password/2FA is required; this keeper trajectory will not authenticate. An explicitly authorized apple_login is the only permitted login path.');
  }
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


async function screenshot(name) {
  const r = await sendCmd({ action: 'screenshot' });
  console.log(`[keeper] screenshot ${name} -> ${r.ok ? r.path : r.error}`);
  return r;
}


// Navigate directly to the protected page and refuse any authentication prompt.
const reviewUrl = `https://appstoreconnect.apple.com/apps/${APP_ID}/distribution`;
console.log(`[keeper] navigating to ${reviewUrl}`);
await nav(reviewUrl);
await sleep(6000);
await assertAuthenticatedSession();

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

const protectedUrl = new URL(await currentUrl() || 'about:blank');
const expectedPath = `/apps/${APP_ID}/distribution`;
const authenticatedProtectedPage = protectedUrl.hostname === 'appstoreconnect.apple.com'
  && protectedUrl.pathname.startsWith(expectedPath)
  && snippets.length > 0;
if (!authenticatedProtectedPage) {
  throw new Error('FAIL_CLOSED: authenticated App Store Connect distribution page was not confirmed; run an explicitly authorized apple_login before retrying.');
}

await screenshot('turbot_review');
console.log('[keeper] DONE');
process.exit(0);
