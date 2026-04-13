/**
 * Generic vision-driven login flow — 1:1 port of weles/agent/login.py
 *
 * Works on any login form on any site. Uses Claude vision to identify
 * the username field, password field, and submit button. No selectors,
 * no per-site code.
 */

import * as vision from './vision.js';
import { waitCloudflare } from '../cloudflare/challenge.js';

function getUrl(page: any): string {
  try { return page.url(); } catch { /* skip */ }
  try { return page.url; } catch { /* skip */ }
  return '';
}

async function waitNavigation(page: any, preUrl: string, timeoutMs: number): Promise<boolean> {
  try {
    await page.waitForFunction(
      `() => window.location.href !== ${JSON.stringify(preUrl)}`,
      { timeout: timeoutMs },
    );
    return true;
  } catch {
    return false;
  }
}

export async function run(
  page: any,
  username: string,
  password: string,
  postLoginTimeoutMs = 30000,
): Promise<boolean> {
  await waitCloudflare(page);

  const preLoginUrl = getUrl(page);

  if (!await vision.fill(page, 'the username or email input field of the login form', username)) {
    console.log('[login] could not find username field');
    return false;
  }

  if (!await vision.fill(page, 'the password input field of the login form', password)) {
    console.log('[login] could not find password field');
    return false;
  }

  await page.keyboard.press('Enter');
  console.log('[login] submitted form via Enter, waiting for navigation');

  if (!await waitNavigation(page, preLoginUrl, 8000)) {
    console.log('[login] Enter did not navigate, scrolling and clicking submit');
    try { await page.evaluate('window.scrollBy(0, 600)'); } catch { /* skip */ }
    if (!await vision.click(page, 'the submit button of the login form (Log In, Sign In, Continue, Submit, etc.)')) {
      console.log('[login] could not find submit button after scroll');
      return false;
    }
    if (!await waitNavigation(page, preLoginUrl, postLoginTimeoutMs)) {
      console.log('[login] navigation timed out after submit click');
      return false;
    }
  }

  await waitCloudflare(page);

  const newUrl = getUrl(page);
  const success = !newUrl.toLowerCase().includes('login') && !newUrl.toLowerCase().includes('signin');
  console.log(`[login] post-submit url=${newUrl} success=${success}`);
  return success;
}
