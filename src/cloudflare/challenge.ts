/**
 * Cloudflare challenge detection and bypass — 1:1 port of weles/cloudflare/challenge.py
 *
 * Uses Claude vision to detect the challenge and locate the verification
 * checkbox. The click is dispatched through CDPMouse with Bezier curves.
 */

import { askPage, checkPage, findClickTarget, type ScreenshottablePage } from '../vision/analyze.js';

const CF_CHECK_INTERVAL_MS = 3000;

// Fast-path DOM check: real Cloudflare challenge pages always contain one of
// these strings in title/body. If none match, skip the vision call entirely
// (askClaude shells out to the LLM router and adds 5-15s per page on every
// goto, even on platforms that never serve CF). Verified 2026-05-02:
// LinkedIn /feed/ on stale cookies stalled WSession.goto for 70+ s in this
// path because LinkedIn doesn't use Cloudflare and the vision call hung.
async function looksLikeCloudflareDom(page: any): Promise<boolean> {
  try {
    const r = await page.evaluate(() => {
      const t = (document.title || '').toLowerCase();
      const b = (document.body?.innerText || '').slice(0, 600).toLowerCase();
      const hasCfMarker = /cloudflare|just a moment|attention required|checking your browser|verifying you are human|enable javascript and cookies/.test(t + ' ' + b);
      const hasCfFrame = !!document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="cdn-cgi/challenge-platform"]');
      return hasCfMarker || hasCfFrame;
    });
    return !!r;
  } catch { return false; }
}

export async function waitCloudflare(page: any, timeoutMs = 72000, settleMs = 5000): Promise<boolean> {
  await page.waitForTimeout(settleMs);

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

  const checks = Math.floor(timeoutMs / CF_CHECK_INTERVAL_MS);
  for (let i = 0; i < checks; i++) {
    await page.waitForTimeout(CF_CHECK_INTERVAL_MS);
    const stillCf = await checkPage(
      page as ScreenshottablePage,
      'Is this a Cloudflare security verification or challenge page?',
    );
    console.log(`  [cloudflare] check ${i + 1}/${checks}: still challenged = ${stillCf}`);
    if (!stillCf) return true;
  }

  return false;
}

export async function isChallenged(page: any): Promise<boolean> {
  return checkPage(
    page as ScreenshottablePage,
    'Is this a Cloudflare security verification or challenge page?',
  );
}

export async function bypassCloudflare(page: any, timeoutMs = 72000): Promise<boolean> {
  return waitCloudflare(page, timeoutMs);
}

export type { ScreenshottablePage as CFPage };
