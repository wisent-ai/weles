// Probe the non-submitting Add flow for Meta Business Settings assets.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const BUSINESS_ID = process.env.META_BUSINESS_ID || process.env.BUSINESS_ID || '885982240795843';
const ASSET_KIND = process.env.META_ASSET_KIND || 'apps';
const WAIT_MS = Number(process.env.WAIT_MS || 3000);
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1440x1000';

const pagePaths = {
  apps: 'apps',
  ad_accounts: 'ad_accounts',
  system_users: 'system_users',
};

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
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"], input, textarea, [aria-label]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = textOf(el) || el.getAttribute('placeholder') || '';
        return {
          text: text.slice(0, 220),
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
      bodyText: textOf(document.body).slice(0, 3200),
      controls,
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

async function clickEnabledAdd(page) {
  const target = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el),
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          score: rect.left > 300 ? 1000 - rect.top : 0,
        };
      })
      .filter((item) => /^add$|^dodaj$/i.test(item.text) && !item.disabled)
      .sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(1500).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked_add', text: target.text, x: target.x, y: target.y }));
  return target;
}

const path = pagePaths[ASSET_KIND];
if (!path) {
  console.log(`FAIL: unsupported META_ASSET_KIND=${ASSET_KIND}`);
  process.exit(1);
}

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  businessId: BUSINESS_ID,
  assetKind: ASSET_KIND,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
}, null, 2));

const s = await WSession.start({
  label: `meta_business_add_${ASSET_KIND}_probe`,
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  const url = `https://business.facebook.com/latest/settings/${path}?business_id=${encodeURIComponent(BUSINESS_ID)}`;
  await s.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await snapshot(s.page, 'before_add');
  const clicked = await clickEnabledAdd(s.page);
  if (!clicked) {
    exitCode = 1;
    console.log('FAIL: no enabled Add/Dodaj control found');
  } else {
    await snapshot(s.page, 'after_add');
  }
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
