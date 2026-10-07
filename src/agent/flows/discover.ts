/**
 * Page discovery via vision.
 *
 * Given a page and a description, look for the value on the current page;
 * if it is not there, follow the navigation target most likely to show it,
 * and repeat. The walk ends when the value is found, when the page offers
 * no navigation target, or when a click lands on a page the walk has already
 * read: no count of steps is chosen.
 */

import * as vision from './vision.js';
import { waitCloudflare } from '../../cloudflare/challenge.js';

/** The page the vision helpers act on, as they declare it. */
type DiscoveryPage = Parameters<typeof vision.click> extends [infer Page, ...unknown[]] ? Page : never;

async function walk<T>(
  page: DiscoveryPage,
  what: string,
  read: () => Promise<T | null>,
  navTarget: string,
): Promise<T | null> {
  const seen = new Set<string>();
  for (;;) {
    seen.add(page.url());
    const value = await read();
    if (value !== null) {
      console.log(`[discover] found '${what}' at ${page.url()}`);
      return value;
    }
    const clicked = await vision.click(page, navTarget);
    if (!clicked) {
      console.log(`[discover] no navigation target at ${page.url()}`);
      return null;
    }
    await page.waitForLoadState('networkidle');
    if (seen.has(page.url())) {
      console.log(`[discover] navigation returned to ${page.url()}, already read, without '${what}'`);
      return null;
    }
  }
}

export async function findNumber(page: DiscoveryPage, what: string): Promise<number | null> {
  return walk(page, what, async () => {
    await waitCloudflare(page);
    return vision.number(page, what);
  }, `the navigation link, menu item, or button most likely `
    + `to lead to a page that shows ${what}. Examples: billing, `
    + `balance, credits, account, wallet, dashboard, overview`);
}

export async function findText(page: DiscoveryPage, what: string): Promise<string | null> {
  return walk(page, what, () => vision.text(page, what),
    `the navigation link, menu item, or button most likely to lead to a page that shows ${what}`);
}
