// The browser session of the harvest: the stable persona, the authenticated Apple Ads page, and the network capture.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePersona } from '../../../../../dist/browser/persona.js';
import { NAV_TIMEOUT_MS, USER_DATA_DIR, WAIT_AFTER_NAV_MS } from './settings.mjs';

export function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

export function norm(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function isAppleLoginUrl(url) {
  return /idmsa\.apple\.com|appleid\.apple\.com|signin|login/i.test(url || '');
}

export async function requireAuthenticatedSession(s) {
  const url = s.page.url?.() || '';
  if (url === 'about:blank') return false;

  const loginUrl = isAppleLoginUrl(url);
  const authIframe = await s.page.locator('iframe[src*="idmsa.apple.com"], iframe[src*="appleid.apple.com"]').count() > 0;
  let authPrompt = false;
  for (const frame of s.page.frames()) {
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
    console.log('FAIL_CLOSED: Apple login/password/2FA is required; this harvester will not authenticate. An explicitly authorized apple_login is the only permitted login path.');
    return false;
  }
  return true;
}

export async function gotoAndWait(page, url) {
  console.log(`[apple-ads-report-harvest] goto start ${url}`);
  const navigated = await page.goto(url, { waitUntil: 'commit', timeout: NAV_TIMEOUT_MS })
    .then(() => true)
    .catch((error) => {
      console.log(`[apple-ads-report-harvest] goto error ${String(error?.message || error).slice(0, 300)}`);
      return false;
    });
  await page.waitForLoadState('domcontentloaded', { timeout: WAIT_AFTER_NAV_MS }).catch(() => {});
  await page.waitForTimeout(WAIT_AFTER_NAV_MS).catch(() => {});
  console.log(`[apple-ads-report-harvest] goto done navigated=${navigated} url=${page.url?.() || ''}`);
  return Boolean(navigated && (page.url?.() || '') !== 'about:blank');
}

export async function ensureReportPage(page) {
  const url = page.url?.() || '';
  if (/\/report/i.test(url)) return true;
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (/Manage Your Campaigns|Reporting is not in real time|Create Campaign|Campaign end date reached/i.test(text)) return true;
  return false;
}

export function installNetworkCapture(page) {
  const requests = [];
  const responses = [];
  page.on('request', (request) => {
    try {
      const url = request.url();
      if (!/app-ads\.apple\.com\/reporting\/graphql|app-ads\.apple\.com\/cm\/api/i.test(url)) return;
      requests.push({
        ts: Date.now(),
        method: request.method(),
        url,
        postData: String(request.postData() || '').slice(0, 100000),
      });
      if (requests.length > 200) requests.shift();
    } catch {}
  });
  page.on('response', (response) => {
    void (async () => {
      try {
        const url = response.url();
        if (!/app-ads\.apple\.com\/reporting\/graphql|app-ads\.apple\.com\/cm\/api/i.test(url)) return;
        const headers = response.headers();
        const contentType = String(headers['content-type'] || '');
        let body = '';
        if (/json|text|javascript|html|xml/i.test(contentType)) {
          body = (await response.text().catch(() => '')).slice(0, 1000000);
        }
        responses.push({
          ts: Date.now(),
          method: response.request()?.method?.() || 'GET',
          url,
          status: response.status(),
          contentType,
          body,
        });
        if (responses.length > 200) responses.shift();
      } catch {}
    })();
  });
  return { requests, responses };
}
