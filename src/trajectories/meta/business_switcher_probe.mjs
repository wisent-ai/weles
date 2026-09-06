// Probe Meta Business Suite's portfolio switcher with a logged-in Weles profile.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
const BUSINESS_ID = process.env.META_BUSINESS_ID || process.env.BUSINESS_ID || '885982240795843';
const WAIT_MS = Number(process.env.WAIT_MS || 4000);
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
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a, [role="menuitem"], [aria-label]'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: textOf(el).slice(0, 220),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          href: el.getAttribute('href') || '',
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2),
        };
      })
      .filter((item) => item.text || item.href)
      .slice(0, 140);
    const links = Array.from(document.querySelectorAll('a[href]'))
      .map((el) => ({
        text: textOf(el).slice(0, 180),
        href: el.getAttribute('href') || '',
      }))
      .filter(({ href }) => /business_id=|business\.facebook\.com/.test(href))
      .slice(0, 80);
    const bodyText = textOf(document.body);
    return {
      title: document.title || null,
      bodyText: bodyText.slice(0, 2600),
      controls,
      links,
      businessIds: Array.from(new Set([
        ...bodyText.matchAll(/\b\d{12,18}\b/g),
        ...links.flatMap((link) => [...link.href.matchAll(/business_id=(\d+)/g)].map((match) => match[1])),
      ].map((match) => Array.isArray(match) ? match[0] : match))).slice(0, 30),
    };
  });
  console.log(JSON.stringify({
    stage: 'snapshot',
    label,
    url: sanitizedUrl(page.url?.() || ''),
    ...data,
    links: data.links.map((link) => ({ ...link, href: sanitizedUrl(link.href) })),
  }, null, 2));
  return data;
}

async function clickBusinessSwitcher(page) {
  const topLeft = { text: 'top-left portfolio selector', x: 220, y: 36 };
  await page.mouse.click(topLeft.x, topLeft.y, { delay: 50 });
  await page.waitForTimeout(1500).catch(() => {});
  const opened = await page.evaluate(() => {
    const bodyText = (document.body?.innerText || '').replace(/\s+/g, ' ');
    return /switch|przełącz|portfolio|firmowe|business/i.test(bodyText) && /Wisent-AI/i.test(bodyText);
  }).catch(() => false);
  if (opened) {
    console.log(JSON.stringify({ stage: 'clicked_switcher', ...topLeft }));
    return topLeft;
  }

  const target = await page.evaluate(() => {
    const textOf = (el) => (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const controls = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], a'))
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        const text = textOf(el);
        let score = 0;
        if (/Wisent|portfolio|firmowe|business/i.test(text)) score += 1000;
        if (rect.top < 80 && rect.left < 360) score += 1000;
        if (/Meta Business Suite|All Tools|Pomoc|Powiadomienia/i.test(text)) score -= 1000;
        return { text, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    return controls[0] || null;
  }).catch(() => null);
  if (!target) return null;
  await page.mouse.click(target.x, target.y, { delay: 50 });
  await page.waitForTimeout(1500).catch(() => {});
  console.log(JSON.stringify({ stage: 'clicked_switcher', text: target.text, x: target.x, y: target.y }));
  return target;
}

console.log(JSON.stringify({
  stage: 'start',
  userDataDir: USER_DATA_DIR,
  businessId: BUSINESS_ID,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
}, null, 2));

const s = await WSession.start({
  label: 'meta_business_switcher_probe',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_BUSINESS_HEADLESS !== '0',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  const url = `https://business.facebook.com/latest/settings/business_users?business_id=${encodeURIComponent(BUSINESS_ID)}`;
  await s.page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await snapshot(s.page, 'before_switcher');
  const clicked = await clickBusinessSwitcher(s.page);
  if (!clicked) {
    exitCode = 1;
    console.log('FAIL: no business switcher control found');
  } else {
    await snapshot(s.page, 'after_switcher');
  }
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
