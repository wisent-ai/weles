// How the run types text into somebody else's form and starts the scan: find
// the first writable field among the shapes the Pangram dashboard has had, wait
// for it, type like a human and check the text really landed, take down the
// cookie banner that covers the button, pick the real scan button apart from the
// marketing buttons with similar labels, and read the visible credit state.

import { humanClickLocator } from '../../../../../dist/human/mouse.js';
import { pageCondition, pageSettled } from '../../../_shared/page/settled.mjs';
import { humanFill, humanType } from '../../../../../dist/human/keyboard.js';
import {
  clickDescribed,
  clickOffered,
} from '../../../_shared/page/judged/seen.mjs';

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
      if ((await one.isVisible()) && !(await one.isDisabled()))
        return { locator: one, selector };
    }
  }
  return null;
}

/** Wait until the page shows a visible, enabled field of one of the known
 * shapes, for as long as the dashboard takes to render it. */
async function waitForWritableLocator(page) {
  await pageCondition(
    page,
    (selectors) =>
      selectors.some((selector) =>
        Array.from(document.querySelectorAll(selector)).some((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return (
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            rect.width > 0 &&
            rect.height > 0 &&
            !el.disabled
          );
        }),
      ),
    WRITABLE_SELECTORS,
  );
  const hit = await firstWritableLocator(page);
  if (!hit)
    throw new Error(`pangram_input_not_found url=${page.url?.() ?? ''}`);
  return hit;
}

// How many leading characters the public checker gets typed key by key
// before the rest is filled: PANGRAM_PUBLIC_HUMAN_WARMUP_CHARS, a whole
// number of characters. Unset, nothing is typed first; a value that is not a
// whole number is refused naming it, never read as zero.
function publicWarmupChars() {
  const stated = process.env.PANGRAM_PUBLIC_HUMAN_WARMUP_CHARS;
  if (stated === undefined || stated === '') return 0;
  if (!/^\d+$/.test(stated.trim()))
    throw new Error(
      `pangram_warmup_invalid: PANGRAM_PUBLIC_HUMAN_WARMUP_CHARS is ${JSON.stringify(stated)}, not a whole number of characters; set it to one, or unset it to type nothing first`,
    );
  return Number(stated.trim());
}

export async function fillInput(page, text) {
  const hit = await waitForWritableLocator(page);
  await hit.locator.scrollIntoViewIfNeeded();
  await humanClickLocator(page, hit.locator).catch((error) => {
    console.log(
      `[pangram] the human click on ${hit.selector} failed, so the field is focused directly: ${error instanceof Error ? error.message : String(error)}`,
    );
    return hit.locator.focus();
  });
  if (process.env.PANGRAM_NO_ACCOUNT === '1') {
    const warmup = text.slice(0, publicWarmupChars());
    if (warmup) await humanType(page, warmup);
  }
  await humanFill(page, hit.locator, text);
  const valueLength = await hit.locator.evaluate((el) => {
    if ('value' in el) return String(el.value || '').length;
    return String(el.innerText || el.textContent || '').length;
  });
  if (valueLength < Math.min(text.length, 20))
    throw new Error(
      `pangram_input_fill_failed selector=${hit.selector} length=${valueLength}`,
    );
  return hit.selector;
}

// The consent banner covers the scan button; accepting it takes it down.
export async function dismissCookieBanner(page) {
  return (await clickOffered(page, 'the button that accepts all cookies'))
    ? 'clicked'
    : 'none';
}

// The scan button is told apart from the marketing and navigation buttons
// with similar labels by the vision model.
export async function clickAnalyze(page) {
  const description =
    'the enabled button that scans the entered text for AI (not a marketing, upload or navigation button)';
  await clickDescribed(page, description);
  return description;
}

export async function readVisibleCreditState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || '';
    const match = text.match(/Available\s+(\d+)\s*\/\s*(\d+)/i);
    if (!match) return null;
    return {
      available: Number(match[1]),
      total: Number(match[2]),
      sample: text.slice(
        Math.max(0, match.index - 80),
        Math.min(text.length, match.index + 120),
      ),
    };
  }); // allow-raw-playwright: read-only visible Pangram credit state
}
