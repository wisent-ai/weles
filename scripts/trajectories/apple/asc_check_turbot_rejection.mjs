// Log into App Store Connect, wait for a 2FA code supplied via file,
// then navigate to the Turbot app review/distribution page and extract
// the rejection details that Apple does not expose through the API.
//
// Usage:
//   node scripts/trajectories/apple/asc_check_turbot_rejection.mjs
//
// When 2FA is required the script prints:
//   "2FA_REQUIRED: /tmp/weles_2fa_code.txt"
// and polls that file for a 6-digit code. Write the code to the file
// (e.g. echo 123456 > /tmp/weles_2fa_code.txt) and the script will continue.

import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { persistFreshCookieJar } from '../_shared/cookie-freshness.mjs';
import { promises as fs } from 'node:fs';
import { setTimeout } from 'node:timers/promises';

const APP_ID = process.env.APP_ID || '6502873271';
const TWO_FA_FILE = '/tmp/weles_2fa_code.txt';
const TWO_FA_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

const acct = await getSocialAccount('apple');
if (!acct) { console.log('FAIL: no active apple account in DB'); process.exit(1); }
if (!acct.metadata?.email || !acct.metadata?.password) { console.log('FAIL: apple account missing email/password'); process.exit(1); }

const email = acct.metadata.email;
const password = acct.metadata.password;
console.log(`[turbot-review] using account: ${acct.username} (${email})`);

async function waitFor2FACode() {
  console.log(`2FA_REQUIRED: ${TWO_FA_FILE}`);
  console.log('[turbot-review] waiting for 6-digit Apple 2FA code...');
  const deadline = Date.now() + TWO_FA_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const raw = (await fs.readFile(TWO_FA_FILE, 'utf8')).trim();
      const code = raw.replace(/\D/g, '');
      if (code.length === 6) {
        console.log(`[turbot-review] 2FA code received: ${code}`);
        return code;
      }
    } catch (e) {
      // file not written yet
    }
    await setTimeout(1000);
  }
  throw new Error('Timed out waiting for 2FA code');
}

async function extractReviewInfo(page) {
  // Wait for the page to settle.
  await setTimeout(6000);

  const info = await page.evaluate(() => {
    const text = document.body?.innerText || '';
    const buttons = Array.from(document.querySelectorAll('button'))
      .map(b => (b.textContent || '').trim())
      .filter(t => t.length > 0);
    const links = Array.from(document.querySelectorAll('a'))
      .map(a => (a.textContent || '').trim())
      .filter(t => t.length > 0);
    return { text, buttons, links };
  }).catch(() => ({ text: '', buttons: [], links: [] }));

  const relevantTerms = [
    'rejected', 'rejection', 'unresolved', 'issues', 'guideline',
    'resolution', 'review', 'pending', 'waiting for review',
    'app review', 'binary rejected', 'metadata rejected',
    'age rating', 'content rights', 'minor', '18+',
  ];

  const lower = info.text.toLowerCase();
  const snippets = [];
  for (const term of relevantTerms) {
    let idx = lower.indexOf(term);
    while (idx !== -1) {
      const start = Math.max(0, idx - 120);
      const end = Math.min(info.text.length, idx + 250);
      snippets.push(info.text.slice(start, end).replace(/\s+/g, ' ').trim());
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

  const screenshotPath = '/tmp/turbot_asc_review.png';
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`[turbot-review] screenshot saved: ${screenshotPath}`);
  } catch (e) {
    console.log('[turbot-review] screenshot failed:', e.message?.slice(0, 120));
  }
}

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'apple_asc_turbot_review', proxy: proxyUrl ?? (process.env.PROXY_URL || undefined), persona });

try {
  await s.goto('https://appstoreconnect.apple.com');
  await s.wait(5);

  const authFrame = await s.page.waitForSelector('iframe[src*="idmsa.apple.com"]', { timeout: 30_000 }).catch(() => null);
  if (!authFrame) { console.log('FAIL: no idmsa auth iframe found'); process.exit(1); }
  const frame = await authFrame.contentFrame();
  if (!frame) { console.log('FAIL: could not access auth iframe'); process.exit(1); }
  console.log('[turbot-review] auth iframe loaded');

  await frame.waitForSelector('#account_name_text_field', { timeout: 15_000 });
  await frame.locator('#account_name_text_field').fill(email);
  await frame.locator('#sign-in').click();
  await s.wait(5);

  const continuePwBtn = frame.locator('#continue-password');
  if (await continuePwBtn.isVisible().catch(() => false)) {
    await continuePwBtn.click();
    await s.wait(4);
  }

  const pwSelectors = ['#password_text_field', 'input[type="password"]', 'input[name="password"]', 'input[aria-label*="assword"]'];
  let pwField = null;
  for (const sel of pwSelectors) {
    const visible = await frame.locator(sel).first().isVisible().catch(() => false);
    if (visible) { pwField = sel; break; }
  }
  if (!pwField) { console.log('FAIL: password field not found'); process.exit(1); }
  await frame.locator(pwField).first().fill(password);
  await frame.locator('#sign-in').click();
  await s.wait(5);

  const twoFaInput = await frame.locator('input[aria-label*="digit"], input[aria-label*="Digit"], input[id*="char"], input[type="tel"][maxlength="1"]').first().isVisible().catch(() => false);
  if (twoFaInput) {
    const code = await waitFor2FACode();
    const inputs = await frame.locator('input[aria-label*="digit"], input[aria-label*="Digit"], input[id*="char"], input[type="tel"][maxlength="1"]').all();
    if (inputs.length >= 6) {
      for (let i = 0; i < 6; i++) await inputs[i].fill(code[i]);
    } else if (inputs.length === 1) {
      await inputs[0].fill(code);
    } else {
      console.log(`FAIL: unexpected 2FA input count: ${inputs.length}`);
      process.exit(1);
    }
    await s.wait(3);
    const trustBtn = frame.locator('button:has-text("Trust")').first();
    if (await trustBtn.isVisible().catch(() => false)) {
      await trustBtn.click();
      console.log('[turbot-review] clicked Trust');
    }
    await s.wait(5);
  }

  // Wait for dashboard.
  for (let i = 0; i < 30; i++) {
    const url = s.page.url?.() ?? '';
    if (url.includes('appstoreconnect.apple.com') && !url.includes('/login') && !url.includes('idmsa')) {
      console.log(`[turbot-review] logged in — ${url}`);
      try {
        const cookies = await s.ctx.cookies();
        await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl, currentPersona: persona });
      } catch (e) { /* best effort */ }
      break;
    }
    await s.wait(1);
  }

  // Navigate to Turbot distribution/review page.
  const reviewUrl = `https://appstoreconnect.apple.com/apps/${APP_ID}/distribution`;
  console.log(`[turbot-review] navigating to ${reviewUrl}`);
  await s.goto(reviewUrl);
  await extractReviewInfo(s.page);

  console.log('PASS: Turbot review info extracted');
  process.exit(0);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
