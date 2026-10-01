/**
 * Cloudflare challenge detection and bypass — 1:1 port of weles/cloudflare/challenge.py
 *
 * Uses Claude vision to detect the challenge and locate the verification
 * checkbox. The click is dispatched through CDPMouse with Bezier curves.
 */

import { askPage, checkPage, findClickTarget, type ScreenshottablePage } from '../vision/analyze.js';

// Resolves on the page's next document load. Cloudflare clears a challenge by
// loading the protected page in place, so each load is the moment to look again.
function nextLoad(page: any): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const onLoad = () => { page.off('load', onLoad); resolve(); };
  page.on('load', onLoad);
  return promise;
}

// Fast-path DOM check: real Cloudflare challenge pages always contain one of
// these strings in title/body. If none match, skip the vision call entirely
// (the authenticated vision route adds latency on every page, even on
// platforms that never serve Cloudflare). Verified 2026-05-02:
// LinkedIn /feed/ on stale cookies stalled WSession.goto for 70+ s in this
// path because LinkedIn doesn't use Cloudflare and the vision call hung.
async function looksLikeCloudflareDom(page: any): Promise<boolean> {
  try {
    const r = await page.evaluate(() => {
      const t = (document.title || '').toLowerCase();
      const b = (document.body?.innerText || '').toLowerCase();
      const hasCfMarker = /cloudflare|just a moment|attention required|checking your browser|verifying you are human|enable javascript and cookies/.test(t + ' ' + b);
      const hasCfFrame = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="cdn-cgi/challenge-platform"]');
      return hasCfMarker || hasCfFrame;
    });
    return !!r;
  } catch { return false; }
}

export async function waitCloudflare(page: any): Promise<boolean> {
  await page.waitForLoadState('load');

  // Cheap DOM probe before the expensive vision call. If the page has zero
  // Cloudflare-shaped markers, return true immediately (treated as "not
  // challenged"). Saves a round-trip per goto on every non-CF platform.
  if (!(await looksLikeCloudflareDom(page))) return true;

  const rawAnswer = await askPage(
    page as ScreenshottablePage,
    'Is this a Cloudflare security verification or challenge page? Answer only YES or NO.',
  );
  const isCf = rawAnswer.trim().toUpperCase().startsWith('YES');
  console.log(`  [cloudflare] raw vision answer: ${JSON.stringify(rawAnswer)}`);
  console.log(`  [cloudflare] challenge detected: ${isCf}`);

  if (!isCf) return true;

  const cleared = nextLoad(page);
  const target = await findClickTarget(
    page as ScreenshottablePage,
    'the checkbox or button to verify you are human',
  );
  console.log(`  [cloudflare] click target: ${JSON.stringify(target)}`);
  if (!target) {
    console.log('  [cloudflare] no click target found - challenge in auto-pass mode');
  } else {
    await page.mouse.click(target.x, target.y);
    console.log(`  [cloudflare] clicked at (${target.x}, ${target.y})`);
  }

  // The challenge clearing is the event this waits for: Cloudflare loads the
  // protected page in place when it lets the browser through. Each load is
  // checked once; a load that is still the challenge waits for the next one,
  // and an operator cancelling the run still ends it.
  // The next load is listened for before this one is checked, so a load that
  // lands during the vision call is not missed.
  let pending = cleared;
  for (let check = 1; ; check += 1) {
    await pending;
    pending = nextLoad(page);
    if (!(await looksLikeCloudflareDom(page))) return true;
    const stillCf = await checkPage(
      page as ScreenshottablePage,
      'Is this a Cloudflare security verification or challenge page?',
    );
    console.log(`  [cloudflare] load ${check}: still challenged = ${stillCf}`);
    if (!stillCf) return true;
  }
}

export async function isChallenged(page: any): Promise<boolean> {
  return checkPage(
    page as ScreenshottablePage,
    'Is this a Cloudflare security verification or challenge page?',
  );
}

export async function bypassCloudflare(page: any): Promise<boolean> {
  return waitCloudflare(page);
}

export type { ScreenshottablePage as CFPage };
