/**
 * Page discovery via vision — 1:1 port of weles/agent/discover.py
 *
 * Given a page and a description, look for the value on the current
 * page; if not present, find a navigation link and click it, then
 * repeat. Generic over any dashboard.
 */

import * as vision from './vision.js';

const DEFAULT_DEPTH = 4;

export async function findNumber(
  page: any,
  what: string,
  depth = DEFAULT_DEPTH,
): Promise<number | null> {
  for (let step = 0; step < depth; step++) {
    const value = await vision.number(page, what);
    if (value !== null) {
      console.log(`[discover] found '${what}' = ${value} at depth ${step}`);
      return value;
    }
    const navTarget =
      `the navigation link, menu item, or button most likely `
      + `to lead to a page that shows ${what}. Examples: billing, `
      + `balance, credits, account, wallet, dashboard, overview`;
    const clicked = await vision.click(page, navTarget);
    if (!clicked) {
      console.log(`[discover] no navigation target at depth ${step}`);
      return null;
    }
    try { await page.waitForLoadState('networkidle'); } catch { /* skip */ }
  }
  console.log(`[discover] depth ${depth} exhausted without finding '${what}'`);
  return null;
}

export async function findText(
  page: any,
  what: string,
  depth = DEFAULT_DEPTH,
): Promise<string | null> {
  for (let step = 0; step < depth; step++) {
    const value = await vision.text(page, what);
    if (value !== null) return value;
    const navTarget =
      `the navigation link, menu item, or button most likely `
      + `to lead to a page that shows ${what}`;
    const clicked = await vision.click(page, navTarget);
    if (!clicked) return null;
    try { await page.waitForLoadState('networkidle'); } catch { /* skip */ }
  }
  return null;
}
