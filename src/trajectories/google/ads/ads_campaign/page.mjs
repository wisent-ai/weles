// The Google Ads page as the campaign trajectory drives it: clicks, fills, waits and the customer switch.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generatePersona } from '../../../../../dist/browser/persona.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { humanFill, humanType } from '../../../../../dist/human/keyboard.js';
import { CUSTOMER_ID, NAV_TIMEOUT_MS, USER_DATA_DIR } from './settings.mjs';

export function stableProfilePersona() {
  const p = join(USER_DATA_DIR, 'persona.json');
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  const persona = generatePersona({ os: 'macos', browser: 'chromium' });
  writeFileSync(p, JSON.stringify(persona, null, 2));
  return persona;
}
export async function clickAny(s, selectors, label, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sel of selectors) {
      const loc = s.page.locator(sel).filter({ visible: true }).first();
      if (await withTimeout(loc.isVisible(), 1500, false).catch(() => false)) {
        const clicked = await withTimeout(humanClickLocator(s.page, loc), 5000, false).catch(() => false);
        if (!clicked) {
          console.log(`[google-ads] WARN: click timed out: ${label} (${sel})`);
          continue;
        }
        console.log(`[google-ads] clicked: ${label}`);
        await humanIdlePause('short');
        return true;
      }
    }
    await s.wait(1);
  }
  return false;
}

export async function clickText(s, text, label = text, timeoutMs = 5000) {
  const escaped = String(text).replaceAll('"', '\\"');
  const clicked = await clickAny(s, [
    `[role="radio"]:has-text("${escaped}")`,
    `material-radio:has-text("${escaped}")`,
    `material-list-item:has-text("${escaped}")`,
  ], label, timeoutMs);
  if (clicked) return true;
  const fallback = s.page.locator('button,[role="button"],[role="radio"],material-radio,material-list-item')
    .filter({ hasText: text, visible: true }).first();
  if (await fallback.count() === 0) return false;
  const fallbackClicked = await withTimeout(humanClickLocator(s.page, fallback), 5000, false).catch(() => false);
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
    if (await withTimeout(loc.isVisible(), 1500, false).catch(() => false)) {
      const filled = await withTimeout(humanFill(s.page, loc, String(value)), 6000, false).catch(() => false);
      if (!filled) {
        console.log(`[google-ads] WARN: fill timed out: ${label} (${sel})`);
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
    if (!(await withTimeout(loc.isVisible(), 1500, false).catch(() => false))) continue;
    const clicked = await withTimeout(humanClickLocator(s.page, loc), 5000, false).catch(() => false);
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

export async function waitForPageText(s, pattern, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const text = await pageText(s);
    if (pattern.test(text)) return true;
    await s.wait(1);
  }
  return false;
}

export async function gotoWithTimeout(s, url, label) {
  const ok = await withTimeout(
    s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).then(() => true),
    NAV_TIMEOUT_MS,
    false,
  ).catch(() => false);
  if (!ok) {
    console.log(`[google-ads] WARN: navigation timed out: ${label}`);
    return false;
  }
  return true;
}

export function withTimeout(promise, timeoutMs, fallback) {
  return Promise.race([
    promise,
    new Promise((resolve) => setTimeout(() => resolve(fallback), timeoutMs)),
  ]);
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
  await gotoWithTimeout(s, switchUrl, `customer ${target}`);
  await s.wait(8);
  const after = currentCustomerId(s.page.url?.() ?? '');
  console.log(`[google-ads] customer after switch=${after || 'unknown'}`);
  if (after && after !== target) {
    console.log(`FAIL: wrong Google Ads customer selected; expected=${target} actual=${after} url=${s.page.url?.() ?? ''}`);
    process.exit(1);
  }
  return after;
}
