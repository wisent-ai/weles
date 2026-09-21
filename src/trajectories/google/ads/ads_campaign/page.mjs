// The Google Ads page as the campaign trajectory drives it: clicks, fills, waits and the customer switch.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePersona } from '../../../../../dist/browser/persona.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill, humanType } from '../../../../../dist/human/keyboard.js';
import { CUSTOMER_ID, USER_DATA_DIR } from './settings.mjs';

export function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}
// Click the first of these selectors the page is showing. The old shape
// polled for five seconds, raced every click against another five, and
// logged "click timed out" about a page that was merely busy; what the page
// shows is a fact it states now.
export async function clickAny(s, selectors, label) {
  for (const sel of selectors) {
    const loc = s.page.locator(sel).filter({ visible: true }).first();
    if (!(await loc.isVisible().catch(() => false))) continue;
    const clicked = await humanClickLocator(s.page, loc).then(() => true).catch(() => false);
    if (!clicked) continue;
    console.log(`[google-ads] clicked: ${label}`);
    await humanIdlePause('short');
    return true;
  }
  return false;
}

export async function clickText(s, text, label = text) {
  const escaped = String(text).replaceAll('"', '\\"');
  const clicked = await clickAny(s, [
    `[role="radio"]:has-text("${escaped}")`,
    `material-radio:has-text("${escaped}")`,
    `material-list-item:has-text("${escaped}")`,
  ], label);
  if (clicked) return true;
  const fallback = s.page.locator('button,[role="button"],[role="radio"],material-radio,material-list-item')
    .filter({ hasText: text, visible: true }).first();
  if (await fallback.count() === 0) return false;
  const fallbackClicked = await humanClickLocator(s.page, fallback).then(() => true).catch(() => false);
  if (fallbackClicked) {
    console.log(`[google-ads] clicked: ${label}`);
    await humanIdlePause('short');
  }
  return fallbackClicked;
}

export async function fillAny(s, selectors, value, label) {
  if (!value) return false;
  for (const sel of selectors) {
    const loc = s.page.locator(sel).filter({ visible: true }).first();
    if (await loc.isVisible().catch(() => false)) {
      const filled = await humanFill(s.page, loc, String(value)).then(() => true).catch(() => false);
      if (!filled) {
        console.log(`[google-ads] WARN: fill failed: ${label} (${sel})`);
        continue;
      }
      console.log(`[google-ads] filled: ${label}`);
      await humanIdlePause('short');
      return true;
    }
  }
  console.log(`[google-ads] WARN: field not found: ${label}`);
  return false;
}

export async function fillTextNearLabel(s, labelPattern, value, label) {
  if (!value) return false;
  const filled = await s.page.evaluate(({ pattern, value }) => {
    const re = new RegExp(pattern, 'i');
    const norm = (text) => String(text || '').replace(/\s+/g, ' ').trim();
    const roots = Array.from(document.querySelectorAll('material-input, material-textarea, label, div, section, form'))
      .filter((el) => re.test(norm(el.innerText || el.textContent || el.getAttribute('aria-label'))));
    for (const root of roots) {
      const input = root.querySelector?.('input,textarea,[contenteditable="true"]');
      if (!input) continue;
      input.focus();
      if (input.isContentEditable) input.textContent = value;
      else input.value = value;
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }, { pattern: labelPattern.source, value: String(value) }).catch(() => false);
  if (filled) {
    console.log(`[google-ads] filled: ${label}`);
    await humanIdlePause('short');
  } else {
    console.log(`[google-ads] WARN: field not found: ${label}`);
  }
  return filled;
}

export async function typeListIntoFirstVisible(s, selectors, csv, label) {
  if (!csv) return false;
  const values = csv.split(',').map((v) => v.trim()).filter(Boolean);
  if (!values.length) return false;
  for (const sel of selectors) {
    const loc = s.page.locator(sel).filter({ visible: true }).first();
    if (!(await loc.isVisible().catch(() => false))) continue;
    const clicked = await humanClickLocator(s.page, loc).then(() => true).catch(() => false);
    if (!clicked) continue;
    for (const value of values) {
      await humanType(s.page, value);
      await s.page.keyboard.press('Enter');
      await humanIdlePause('short');
    }
    console.log(`[google-ads] entered: ${label} (${values.length})`);
    return true;
  }
  console.log(`[google-ads] WARN: list field not found: ${label}`);
  return false;
}

export async function pageText(s) {
  return await s.page.evaluate(() => document.body?.innerText || '').catch(() => '');
}

// The page shows the text when it has rendered it; polling until it does is
// what this wait is for, and the fifteen seconds it used to carry made a
// slow Google Ads screen look like a screen that never loaded.
export async function waitForPageText(s, pattern) {
  for (;;) {
    const text = await pageText(s);
    if (pattern.test(text)) return true;
    await s.wait(1);
  }
}

export async function navigate(s, url, label) {
  const ok = await s.page
    .goto(url, { waitUntil: 'domcontentloaded' })
    .then(() => true)
    .catch(() => false);
  if (!ok) {
    console.log(`[google-ads] WARN: navigation failed: ${label}`);
    return false;
  }
  return true;
}

export async function bringBrowserToFront(s) {
  await s.page.bringToFront().catch(() => {});
}

export function isLoginUrl(url) {
  return /accounts\.google\.com|ServiceLogin|signin/i.test(url);
}

export function normalizeCustomerId(id) {
  return id ? String(id).replace(/\D/g, '') : null;
}

export function currentCustomerId(url) {
  try {
    const u = new URL(url);
    return normalizeCustomerId(u.searchParams.get('ocid') || u.searchParams.get('customerId') || u.searchParams.get('authuser'));
  } catch {
    return null;
  }
}

export async function ensureCustomer(s) {
  const target = normalizeCustomerId(CUSTOMER_ID);
  const before = currentCustomerId(s.page.url?.() ?? '');
  console.log(`[google-ads] current customer=${before || 'unknown'} target=${target || 'unspecified'}`);
  if (!target) return before;
  if (before === target) return before;

  const switchUrl = `https://ads.google.com/aw/campaigns?ocid=${encodeURIComponent(target)}`;
  console.log(`[google-ads] switching customer -> ${target}`);
  await navigate(s, switchUrl, `customer ${target}`);
  await s.wait(8);
  const after = currentCustomerId(s.page.url?.() ?? '');
  console.log(`[google-ads] customer after switch=${after || 'unknown'}`);
  if (after && after !== target) {
    console.log(`FAIL: wrong Google Ads customer selected; expected=${target} actual=${after} url=${s.page.url?.() ?? ''}`);
    process.exit(1);
  }
  return after;
}
