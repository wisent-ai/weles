// Inspect Turbot rejection details through an already authenticated App Store Connect session.
// Authentication is intentionally delegated exclusively to an explicitly authorized apple_login run.
//
// Usage:
//   node scripts/trajectories/apple/asc_check_turbot_rejection_manual_2fa.mjs

import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { persistFreshCookieJar } from '../_shared/cookie-freshness.mjs';
import { setTimeout } from 'node:timers/promises';


const APP_ID = process.env.APP_ID || '6502873271';

const acct = await getSocialAccount('apple');
if (!acct) { console.log('FAIL: no active apple account in DB'); process.exit(1); }
console.log(`[turbot-review] using existing session for account: ${acct.username}`);

async function assertAuthenticatedAppleSession(page) {
  const url = page.url?.() ?? '';
  const loginUrl = /idmsa\.apple\.com|appleid\.apple\.com|\/login(?:[/?#]|$)|signin/i.test(url);
  const authIframe = await page.locator('iframe[src*="idmsa.apple.com"], iframe[src*="appleid.apple.com"]').count() > 0;
  let authPrompt = false;
  for (const frame of page.frames()) {
    authPrompt ||= await frame.locator([
      '#account_name_text_field',
      '#password_text_field',
      'input[type="password"]',
      'input[aria-label*="digit"]',
      'input[aria-label*="Digit"]',
      'input[type="tel"][maxlength="1"]',
    ].join(', ')).first().isVisible().catch(() => false);
    authPrompt ||= await frame.getByText(/Two-Factor Authentication|verification code sent to your Apple devices/i).first().isVisible().catch(() => false);
    if (authPrompt) break;
  }
  if (loginUrl || authIframe || authPrompt) {
    throw new Error('FAIL_CLOSED: Apple login/password/2FA is required; this trajectory will not authenticate. An explicitly authorized apple_login is the only permitted login path.');
  }
}

async function extractReviewInfo(page) {
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
  return { info, snippets };
}

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'apple_asc_turbot_review', proxy: proxyUrl ?? (process.env.PROXY_URL || undefined), persona });

try {
  await s.goto('https://appstoreconnect.apple.com');
  await s.wait(5);

  await assertAuthenticatedAppleSession(s.page);

  try {
    const cookies = await s.ctx.cookies();
    await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl, currentPersona: persona });
  } catch (e) { /* best effort */ }

  const reviewUrl = `https://appstoreconnect.apple.com/apps/${APP_ID}/distribution`;
  console.log(`[turbot-review] navigating to ${reviewUrl}`);
  await s.goto(reviewUrl);
  const reviewInfo = await extractReviewInfo(s.page);
  const protectedUrl = new URL(s.page.url?.() ?? 'about:blank');
  const expectedPath = `/apps/${APP_ID}/distribution`;
  const authenticatedProtectedPage = protectedUrl.hostname === 'appstoreconnect.apple.com'
    && protectedUrl.pathname.startsWith(expectedPath)
    && reviewInfo.snippets.length > 0;
  if (!authenticatedProtectedPage) {
    throw new Error('FAIL_CLOSED: authenticated App Store Connect distribution page was not confirmed; run an explicitly authorized apple_login before retrying.');
  }

  console.log('PASS: Turbot review info extracted');
  process.exit(0);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
