import { checkPage, findClickTarget, type ScreenshottablePage } from '../vision/analyze.js';

export interface CloudflareOptions {
  /** Maximum time (ms) to wait for the challenge to clear. Default 72 000. */
  timeout?: number;
}

/** Minimal page interface expected by the Cloudflare module. */
export interface CFPage extends ScreenshottablePage {
  mouse: { click(x: number, y: number): Promise<void> };
  /** CDP event subscription scoped to the page's session. */
  on(event: string, cb: (params: any) => void): void;
  off(event: string, cb: (params: any) => void): void;
  url?(): string;
}

/**
 * Quick check: is the page currently showing a Cloudflare challenge?
 */
export async function isChallenged(page: CFPage): Promise<boolean> {
  return checkPage(page, 'Is this page showing a Cloudflare challenge or verification screen?');
}

/**
 * Event-driven Cloudflare bypass.
 *
 * 1. Screenshot the page to detect a Cloudflare challenge.
 * 2. If no challenge is found, return `true` immediately.
 * 3. Locate the "Verify you are human" checkbox via vision and click it.
 * 4. Wait for a `Page.frameNavigated` event on the main frame (URL change)
 *    which signals the challenge has been cleared.
 * 5. Return `true` if navigated within the timeout, `false` otherwise.
 */
export async function waitCloudflare(
  page: CFPage,
  options?: CloudflareOptions,
): Promise<boolean> {
  const timeout = options?.timeout ?? 72_000;

  // Step 1 — detect CF challenge
  const challenged = await isChallenged(page);
  if (!challenged) {
    return true;
  }

  // Step 2 — find and click the verify checkbox
  const target = await findClickTarget(page, 'Cloudflare verify / challenge checkbox');
  if (target) {
    await page.mouse.click(target.x, target.y);
  }

  // Step 3 — wait for navigation (challenge cleared) or timeout
  const navigated = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      page.off('Page.frameNavigated', onNavigated);
      resolve(false);
    }, timeout);

    function onNavigated(params: any) {
      // Only care about main-frame navigations (no parentId).
      const frame = params.frame ?? params;
      if (frame.parentId) return;

      clearTimeout(timer);
      page.off('Page.frameNavigated', onNavigated);
      resolve(true);
    }

    page.on('Page.frameNavigated', onNavigated);
  });

  return navigated;
}

/**
 * Convenience wrapper — identical to `waitCloudflare`.
 */
export async function bypassCloudflare(
  page: CFPage,
  options?: CloudflareOptions,
): Promise<boolean> {
  return waitCloudflare(page, options);
}
