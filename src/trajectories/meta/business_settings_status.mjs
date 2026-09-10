// Meta Business Settings inspector for system-user/token paths.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const BUSINESS_ID = process.env.META_BUSINESS_ID || process.env.BUSINESS_ID || '';
const WAIT_MS = Number(process.env.WAIT_MS || 7000);
const PAGE_FILTER = (process.env.META_BUSINESS_SETTINGS_PAGES || '')
  .split(',')
  .map((page) => page.trim())
  .filter(Boolean);
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1440x1000';

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

function sanitizedUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = parsed.hash ? '#<redacted>' : '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|code|secret|state|session|auth/i.test(key)) parsed.searchParams.set(key, '<redacted>');
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

async function clickSafeContinue(page) {
  const allow = /^(continue|kontynuuj|dalej|next|ok|confirm|potwierdź)$/i;
  const deny = /create|utwórz|delete|usuń|remove|cancel|anuluj/i;
  const candidates = page.locator('button, [role="button"], a').filter({ visible: true });
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    const text = String(await candidate.innerText().catch(async () =>
      candidate.getAttribute('aria-label').catch(() => ''))).replace(/\s+/g, ' ').trim();
    if (!allow.test(text) || deny.test(text)) continue;
    await humanClickLocator(page, candidate);
    return text;
  }
  return null;
}

async function snapshot(page, label) {
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  const clicked = await clickSafeContinue(page);
  if (clicked) await page.waitForTimeout(WAIT_MS).catch(() => {});
  const data = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const bodyText = textOf(document.body).slice(0, 3500);
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]'))
      .filter(visible)
      .map((el) => ({
        text: textOf(el).slice(0, 140),
        role: el.getAttribute('role') || el.tagName.toLowerCase(),
        href: el.getAttribute('href') || '',
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
      }))
      .filter((item) => item.text || item.href)
      .slice(0, 100);
    return {
      title: document.title || null,
      bodyText,
      controls,
      statusHints: {
        login: /log in|login|password|email|zaloguj|hasło/i.test(bodyText),
        systemUsers: /system users|systemowi|użytkownicy systemowi|system user/i.test(bodyText),
        tokens: /token|access token|wygeneruj|generate/i.test(bodyText),
        permissionDenied: /permission|uprawn|access denied|brak dostępu|not authorized/i.test(bodyText),
      },
    };
  }).catch((error) => ({ error: error.message || String(error) }));
  console.log(JSON.stringify({
    stage: 'snapshot',
    label,
    clicked: clicked || null,
    url: sanitizedUrl(page.url?.() || ''),
    ...data,
  }, null, 2));
}

const businessQuery = BUSINESS_ID ? `?business_id=${encodeURIComponent(BUSINESS_ID)}` : '';
const urls = [
  ['settings_root', `https://business.facebook.com/settings/${businessQuery}`],
  ['latest_settings', `https://business.facebook.com/latest/settings/${businessQuery}`],
  ['business_users', `https://business.facebook.com/latest/settings/business_users${businessQuery}`],
  ['system_users_latest', `https://business.facebook.com/latest/settings/system_users${businessQuery}`],
  ['ad_accounts_latest', `https://business.facebook.com/latest/settings/ad_accounts${businessQuery}`],
  ['apps_latest', `https://business.facebook.com/latest/settings/apps${businessQuery}`],
  ['connected_apps_latest', `https://business.facebook.com/latest/settings/connected_apps${businessQuery}`],
  ['requests_latest', `https://business.facebook.com/latest/settings/requests${businessQuery}`],
  ['business_info', `https://business.facebook.com/latest/settings/business_info${businessQuery}`],
].filter(([label]) => !PAGE_FILTER.length || PAGE_FILTER.includes(label));

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  businessId: BUSINESS_ID || null,
  pageFilter: PAGE_FILTER,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
}, null, 2));

const s = await WSession.start({
  label: 'meta_business_settings_status',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  for (const [label, url] of urls) {
    await s.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    await snapshot(s.page, label);
  }
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
