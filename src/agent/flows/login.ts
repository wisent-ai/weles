/**
 * Generic vision-driven login flow — 1:1 port of weles/agent/login.py
 *
 * Works on any login form on any site. Uses Claude vision to identify
 * the username field, password field, and submit button. No selectors,
 * no per-site code.
 */

import * as vision from './vision.js';
import { waitCloudflare } from '../../cloudflare/challenge.js';

/** The page surface this flow uses, named rather than left untyped. */
interface LoginPage {
  url: (() => string) | string;
  waitForFunction: (expression: string, options?: { timeout?: number }) => Promise<unknown>;
  keyboard: { press: (key: string) => Promise<void> };
  evaluate: (expression: string) => Promise<unknown>;
  context: () => unknown;
}

function getUrl(page: LoginPage): string {
  try { return typeof page.url === 'function' ? page.url() : page.url; } catch { /* skip */ }
  return '';
}

/**
 * Wait until the page leaves the URL it was on. `timeout: 0` is how Playwright
 * is told to carry no deadline of its own: the navigation is the event this
 * waits for, and a page that is slow to answer is still answering.
 */
async function waitNavigation(page: LoginPage, preUrl: string): Promise<boolean> {
  try {
    await page.waitForFunction(
      `() => window.location.href !== ${JSON.stringify(preUrl)}`,
      { timeout: 0 },
    );
    return true;
  } catch {
    return false;
  }
}

export async function run(
  page: LoginPage,
  username: string,
  password: string,
): Promise<boolean> {
  await waitCloudflare(page);

  const preLoginUrl = getUrl(page);
  let hostname = '';
  try {
    hostname = new URL(preLoginUrl).hostname.toLowerCase();
  } catch {
    // Relative or unavailable URLs are handled by the existing login flow.
  }
  if (hostname === 'apple.com' || hostname.endsWith('.apple.com')) {
    throw new Error('Generic Apple password submission is disabled; use the owner-authorized canonical apple_login flow');
  }

  if (!await vision.fill(page, 'the username or email input field of the login form', username)) {
    console.log('[login] could not find username field');
    return false;
  }

  if (!await vision.fill(page, 'the password input field of the login form', password)) {
    console.log('[login] could not find password field');
    return false;
  }

  // Submit by the control the form actually offers, and only fall back to
  // Enter when the page shows none. The old order pressed Enter, waited eight
  // seconds for a navigation that had not happened yet, and used that silence
  // as the reason to look for a button — so a slow site took the fallback
  // path, and a site that never navigates was declared failed at thirty
  // seconds. Nothing here reads a clock now: what the page shows decides, and
  // the navigation itself ends the wait.
  const submitted = await vision.click(
    page,
    'the submit button of the login form (Log In, Sign In, Continue, Submit, etc.)',
  );
  if (!submitted) {
    console.log('[login] no submit control found, submitting with Enter');
    await page.keyboard.press('Enter');
  }
  console.log('[login] submitted, waiting for navigation');
  if (!await waitNavigation(page, preLoginUrl)) {
    console.log('[login] the page never navigated away from the login URL');
    return false;
  }

  await waitCloudflare(page);

  const newUrl = getUrl(page);
  const success = !newUrl.toLowerCase().includes('login') && !newUrl.toLowerCase().includes('signin');
  console.log(`[login] post-submit url=${newUrl} success=${success}`);
  return success;
}
