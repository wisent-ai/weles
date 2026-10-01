// How the run types text into somebody else's form and starts the scan: find
// the first writable field among the shapes the Pangram dashboard has had, wait
// for it, type like a human and check the text really landed, take down the
// cookie banner that covers the button, pick the real scan button apart from the
// marketing buttons with similar labels, and read the visible credit state.

import { humanClickLocator } from '../../../../../dist/human/mouse.js';
import { pageCondition, pageSettled } from '../../../_shared/page/settled.mjs';
import { humanFill, humanType } from '../../../../../dist/human/keyboard.js';

const WRITABLE_SELECTORS = [
  'textarea[name="text"]',
  'textarea[name*="content" i]',
  'textarea[placeholder*="paste" i]',
  'textarea[placeholder*="text" i]',
  'textarea[placeholder*="document" i]',
  'textarea',
  '[contenteditable="true"][role="textbox"]',
  '[contenteditable="true"]',
  '[role="textbox"]',
  'input[type="text"]',
];

async function firstWritableLocator(page) {
  for (const selector of WRITABLE_SELECTORS) {
    const loc = page.locator(selector);
    const count = await loc.count();
    for (let i = 0; i < Math.min(count, 6); i++) {
      const one = loc.nth(i);
      if (await one.isVisible() && !await one.isDisabled()) return { locator: one, selector };
    }
  }
  return null;
}

/** Wait until the page shows a visible, enabled field of one of the known
 * shapes, for as long as the dashboard takes to render it. */
async function waitForWritableLocator(page) {
  await pageCondition(page, (selectors) => selectors.some((selector) => Array.from(document.querySelectorAll(selector)).some((el) => {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0 && !el.disabled;
  })), WRITABLE_SELECTORS);
  const hit = await firstWritableLocator(page);
  if (!hit) throw new Error(`pangram_input_not_found url=${page.url?.() ?? ''}`);
  return hit;
}

export async function fillInput(page, text) {
  const hit = await waitForWritableLocator(page);
  await hit.locator.scrollIntoViewIfNeeded();
  await humanClickLocator(page, hit.locator).catch(() => hit.locator.focus());
  if (process.env.PANGRAM_NO_ACCOUNT === '1') {
    const warmupChars = Math.max(0, Number(process.env.PANGRAM_PUBLIC_HUMAN_WARMUP_CHARS || 0));
    const warmup = text.slice(0, warmupChars);
    if (warmup) await humanType(page, warmup);
  }
  await humanFill(page, hit.locator, text);
  const valueLength = await hit.locator.evaluate((el) => {
    if ('value' in el) return String(el.value || '').length;
    return String(el.innerText || el.textContent || '').length;
  });
  if (valueLength < Math.min(text.length, 20)) throw new Error(`pangram_input_fill_failed selector=${hit.selector} length=${valueLength}`);
  return hit.selector;
}

export async function dismissCookieBanner(page) {
  const cookieButtons = page.getByRole('button', { name: /allow all|accept all|zgadzam|akceptuj/i });
  const count = await cookieButtons.count();
  for (let i = 0; i < Math.min(count, 4); i++) {
    const btn = cookieButtons.nth(i);
    const visible = await btn.isVisible().catch(() => false);
    const disabled = await btn.isDisabled().catch(() => true);
    if (visible && !disabled) {
      await humanClickLocator(page, btn);
      await pageSettled(page);
      return 'clicked';
    }
  }
  return page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[id*="Cookie"], [class*="cookie"], [class*="Cookie"], [aria-label*="cookie" i], div'));
    let hidden = 0;
    for (const el of nodes) {
      const text = (el.textContent || '');
      if (/This website uses cookies|Allow all|Allow selection|cookie/i.test(text) && el.getClientRects().length) {
        el.style.pointerEvents = 'none';
        if (/This website uses cookies|Allow all|Allow selection/i.test(text)) {
          el.style.display = 'none';
          hidden += 1;
        }
      }
    }
    return hidden ? 'hidden' : 'none';
  }); // allow-raw-playwright: neutralise cookie banner that covers the scan button
}

export async function clickAnalyze(page) {
  const labels = /scan|check|analy[sz]e|submit|run/i;
  const primaryLabels = /^(scan|check)\s+for\s+ai$/i;
  const skip = /scan for ai content|input your text|view results|access past records|detect ai assistance|accuracy|verified|free checks|upload|try it|partner|contact|login|allow/i;
  const byRole = page.getByRole('button', { name: labels });
  const roleCount = await byRole.count();
  const candidates = [];
  for (let i = 0; i < Math.min(roleCount, 20); i++) {
    const btn = byRole.nth(i);
    const visible = await btn.isVisible().catch(() => false);
    const disabled = await btn.isDisabled().catch(() => true);
    const name = ((await btn.innerText()) || (await btn.getAttribute('aria-label')) || '').trim();
    if (visible && !disabled && labels.test(name) && !skip.test(name)) candidates.push({ btn, name });
  }
  const primary = candidates.filter((c) => primaryLabels.test(c.name));
  const visiblePrimaryCount = await page.getByRole('button', { name: primaryLabels }).count();
  const usableCandidates = primary.length ? primary : (visiblePrimaryCount ? [] : candidates);
  usableCandidates.sort((a, b) => {
    const score = (s) => /scan\s*for\s*ai/i.test(s) ? 0 : /scan/i.test(s) ? 1 : /check/i.test(s) ? 2 : 3;
    return score(a.name) - score(b.name);
  });
  if (usableCandidates.length) {
    await usableCandidates[0].btn.scrollIntoViewIfNeeded();
    await humanClickLocator(page, usableCandidates[0].btn);
    return `role:button:${usableCandidates[0].name.slice(0, 80)}`;
  }
  const domScanButtons = page.locator('button,[role="button"],input[type="submit"]').filter({ visible: true });
  let clicked = null;
  for (let i = 0; i < await domScanButtons.count(); i += 1) {
    const button = domScanButtons.nth(i);
    const text = `${await button.textContent()} ${await button.getAttribute('aria-label')} ${await button.getAttribute('value')}`.trim();
    if (labels.test(text) && !skip.test(text) && !await button.isDisabled().catch(() => true)) {
      await humanClickLocator(page, button);
      clicked = text.slice(0, 80);
      break;
    }
  }
  if (!clicked) throw new Error('pangram_analyze_button_not_found');
  return `dom:${clicked}`;
}

export async function readVisibleCreditState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const match = text.match(/Available\s+(\d+)\s*\/\s*(\d+)/i);
    if (!match) return null;
    return {
      available: Number(match[1]),
      total: Number(match[2]),
      sample: text.slice(Math.max(0, match.index - 80), Math.min(text.length, match.index + 120)),
    };
  }); // allow-raw-playwright: read-only visible Pangram credit state
}
