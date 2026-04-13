/**
 * Typed vision extractors — 1:1 port of weles/agent/vision.py
 *
 * number/text/boolean/click/fill take a page and a description in
 * plain English. No selectors, no regex, no per-site code.
 */

import { askPage, findClickTarget, type ScreenshottablePage } from '../vision/analyze.js';

const NONE_MARKERS = ['none', 'null', 'n/a', 'not visible', 'no balance', 'not found'];

function isNoneAnswer(answer: string): boolean {
  const low = answer.trim().toLowerCase();
  if (!low) return true;
  return NONE_MARKERS.some(m => low.includes(m));
}

export async function number(page: any, what: string): Promise<number | null> {
  const answer = await askPage(
    page as ScreenshottablePage,
    `What is ${what} shown on this page? `
    + 'Return ONLY the numeric value (e.g. 12.34) - no currency '
    + 'symbol, no commas, no words. If no such value is visible, '
    + 'return NONE.',
  );
  if (isNoneAnswer(answer)) return null;
  const cleaned = answer.trim().replace(/[^\d.\-]/g, '');
  if (!cleaned) return null;
  const val = parseFloat(cleaned);
  return isNaN(val) ? null : val;
}

export async function text(page: any, what: string): Promise<string | null> {
  const answer = await askPage(
    page as ScreenshottablePage,
    `What is ${what} shown on this page? `
    + 'Return ONLY the text value, no other words. If no such '
    + 'value is visible, return NONE.',
  );
  if (isNoneAnswer(answer)) return null;
  return answer.trim();
}

export async function boolean(page: any, question: string): Promise<boolean> {
  const answer = await askPage(
    page as ScreenshottablePage,
    `${question} Answer ONLY YES or NO.`,
  );
  return answer.trim().toUpperCase().startsWith('YES');
}

export async function click(page: any, targetDescription: string): Promise<boolean> {
  const target = await findClickTarget(page as ScreenshottablePage, targetDescription);
  if (!target) return false;
  await page.mouse.click(target.x, target.y);
  return true;
}

export async function fill(page: any, targetDescription: string, value: string): Promise<boolean> {
  const target = await findClickTarget(page as ScreenshottablePage, targetDescription);
  if (!target) return false;
  await page.mouse.click(target.x, target.y);
  await page.keyboard.type(value);
  return true;
}
