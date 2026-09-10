// Inspect Accounts Center contact info for Meta developer phone verification.
// Prints sanitized UI state and clicks only navigation/contact-info controls.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const WAIT_MS = Number(process.env.WAIT_MS || 3000);
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

function sanitize(text) {
  return String(text || '')
    .replace(/\+\d[\d\s().-]{6,}\d/g, '<phone-redacted>')
    .replace(/\b\d{7,}\b/g, '<number-redacted>');
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

async function bringBrowserToFront(s) {
  await s.page.bringToFront().catch(() => {});
  if (process.platform !== 'darwin') return;
  spawnSync('osascript', ['-e', 'tell application "Chromium" to activate'], { stdio: 'ignore' });
  spawnSync('osascript', ['-e', 'tell application "System Events" to set frontmost of every process whose name is "Chromium" to true'], { stdio: 'ignore' });
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
          text: (textOf(el) || el.getAttribute('placeholder') || '').slice(0, 200),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          href: el.getAttribute('href') || '',
          placeholder: el.getAttribute('placeholder') || '',
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => item.text || item.href || item.placeholder)
      .slice(0, 120);
    return {
      title: document.title || null,
      bodyText: bodyText.slice(0, 3000),
      controls,
      statusHints: {
        contactInfo: /Informacje kontaktowe|Contact info|Email|Phone|Telefon/i.test(bodyText),
        sms: /SMS|confirmation code|kod|potwierdz/i.test(bodyText),
        addPhone: /Add.*phone|Dodaj.*telefon|Dodaj.*numer/i.test(bodyText),
        verify: /Verify|Zweryfikuj|Potwierdź|Confirm/i.test(bodyText),
      },
    };
  });
  console.log(JSON.stringify({
    stage: 'snapshot',
    label,
    url: sanitizedUrl(page.url?.() || ''),
    title: data.title,
    bodyText: sanitize(data.bodyText),
    controls: data.controls.map((control) => ({
      ...control,
      text: sanitize(control.text),
      href: sanitizedUrl(control.href),
    })),
    statusHints: data.statusHints,
  }, null, 2));
  return data;
}

async function clickFirst(page, label, allow, deny = /delete|remove|usuń|anuluj|cancel/i) {
  const target = await page.evaluate(({ allowSource, allowFlags, denySource, denyFlags }) => {
    const allowRe = new RegExp(allowSource, allowFlags);
    const denyRe = new RegExp(denySource, denyFlags);
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          area: rect.width * rect.height,
        };
      })
      .filter((item) => item.text && !item.disabled && allowRe.test(item.text) && !denyRe.test(item.text))
      .sort((a, b) => a.area - b.area);
    return nodes[0] || null;
  }, {
    allowSource: allow.source,
    allowFlags: allow.flags,
    denySource: deny.source,
    denyFlags: deny.flags,
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(WAIT_MS).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked', label, text: sanitize(target.text), x: target.x, y: target.y }));
  return target;
}

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS === '1',
}, null, 2));

const s = await WSession.start({
  label: 'meta_accounts_center_contact_info_probe',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS === '1',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  await bringBrowserToFront(s);
  await s.page.goto('https://accountscenter.facebook.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await snapshot(s.page, 'accounts_center_initial');
  await clickFirst(s.page, 'contact_info', /Informacje kontaktowe|Contact info/i);
  await snapshot(s.page, 'contact_info');
  await clickFirst(s.page, 'existing_phone', /^\+?\d[\d\s().-]{6,}\d$/);
  await snapshot(s.page, 'existing_phone');
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
