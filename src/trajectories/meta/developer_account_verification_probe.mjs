// Probe Meta developer account verification without submitting phone/card data.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const WAIT_MS = Number(process.env.WAIT_MS || 3000);
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

async function snapshot(page, label) {
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  const data = await page.evaluate(() => {
    const textOf = (el) => {
      if (!el) return '';
      return (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    };
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const bodyText = textOf(document.body);
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"], input, textarea, select, [aria-label]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (textOf(el) || el.getAttribute('placeholder') || '').slice(0, 220),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          href: el.getAttribute('href') || '',
          placeholder: el.getAttribute('placeholder') || '',
          type: el.getAttribute('type') || '',
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => item.text || item.href || item.placeholder)
      .slice(0, 120);
    return {
      title: document.title || null,
      bodyText: bodyText.slice(0, 5000),
      controls,
      statusHints: {
        login: /log in|zaloguj|hasło|password/i.test(bodyText),
        phone: /phone|mobile|telefon|numer telefonu/i.test(bodyText),
        card: /credit card|debit card|karta kredytowa|karta/i.test(bodyText),
        alreadyVerified: /verified|zweryfikowano|confirmed|potwierdzono/i.test(bodyText),
        blocked: /cannot|can't|nie można|niedostęp|unavailable|problem/i.test(bodyText),
      },
    };
  });
  console.log(JSON.stringify({
    stage: 'snapshot',
    label,
    url: sanitizedUrl(page.url?.() || ''),
    ...data,
    controls: data.controls.map((control) => ({ ...control, href: sanitizedUrl(control.href) })),
  }, null, 2));
  return data;
}

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS !== '0',
}, null, 2));

const s = await WSession.start({
  label: 'meta_developer_account_verification_probe',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS !== '0',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  await s.page.goto('https://developers.facebook.com/async/developer/account/verification/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await snapshot(s.page, 'verification_page');
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
