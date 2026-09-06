// Find existing Meta Accounts Center phone candidates without printing them.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { generatePersona } from '../../../dist/browser/persona.js';
import { WSession } from '../../../dist/session/wsession.js';

const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'meta_ads');
mkdirSync(USER_DATA_DIR, { recursive: true });
process.env.WELES_VIEWPORT ??= '1280x900';

function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}

function normalizePhone(raw) {
  const trimmed = String(raw || '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  return {
    country: digits.startsWith('48') ? '+48' : digits.startsWith('1') ? '+1' : 'unknown',
    digitCount: digits.length,
    suffix: digits.slice(-2),
  };
}

const s = await WSession.start({
  label: 'meta_accounts_center_phone_candidate_probe',
  browser: process.env.BROWSER || 'chromium',
  proxy: process.env.PROXY_URL || 'direct',
  persona: stableProfilePersona(),
  userDataDir: USER_DATA_DIR,
  headless: process.env.META_VERIFY_HEADLESS === '1',
  pageDiagnostics: process.env.WELES_PAGE_DIAGNOSTICS === '1',
});

let exitCode = 0;
try {
  await s.page.goto('https://accountscenter.facebook.com/youraccount/contact_points/', { waitUntil: 'domcontentloaded' }).catch(() => {});
  await s.page.waitForTimeout(3000).catch(() => {});
  const rawPhones = await s.page.evaluate(() => {
    const textOf = (el) => [
      el.innerText || '',
      el.textContent || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('title') || '',
    ].join(' ');
    const text = [
      document.body?.innerText || '',
      document.body?.textContent || '',
      ...Array.from(document.querySelectorAll('button, [role="button"], a, input, [aria-label], [title]')).map(textOf),
    ].join(' ');
    const matches = text.match(/\+\d[\d\s().-]{6,}\d/g) || [];
    return Array.from(new Set(matches));
  });
  const candidates = rawPhones
    .map(normalizePhone)
    .filter(Boolean)
    .sort((a, b) => {
      if (a.country === '+48' && b.country !== '+48') return -1;
      if (b.country === '+48' && a.country !== '+48') return 1;
      return b.digitCount - a.digitCount;
    });
  console.log(JSON.stringify({
    stage: 'phone_candidates',
    count: candidates.length,
    preferredCountry: candidates[0]?.country || null,
    preferredSuffix: candidates[0]?.suffix || null,
    countries: Array.from(new Set(candidates.map((item) => item.country))),
  }, null, 2));
  if (!candidates.length) exitCode = 2;
} catch (error) {
  exitCode = 1;
  console.log(`FAIL: ${error.message || String(error)}`);
} finally {
  await s.close().catch(() => {});
}

if (exitCode) process.exit(exitCode);
