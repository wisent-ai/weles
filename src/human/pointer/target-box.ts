// ---------------------------------------------------------------------------
// Where a click target really is, once the page has finished moving it.
//
// `scrollIntoViewIfNeeded` returns as soon as the scroll is requested. A
// container styled `scroll-behavior: smooth` then animates for several
// hundred milliseconds, and a bounding box read in that window is the
// element's pre-scroll position — outside the viewport, or on top of a
// neighbour. On 2026-09-10 every click on "Chat with Victoria Lane" in the
// app.wisent.com Featured lane reported success and navigated nowhere: the
// tile sat off the right edge of a smooth-scrolling lane, the box was read
// mid-animation, and the click landed on whatever card was under those
// coordinates at that moment. The box is read again until two consecutive
// reads agree and the rectangle lies inside the viewport; a target that never
// settles inside the viewport is refused by name instead of clicked blindly.
// ---------------------------------------------------------------------------

import { waitMs } from '../../utils/timing.js';

export interface TargetBox { x: number; y: number; width: number; height: number }

/** Reads between which a box must stop moving, and the pause between reads. */
const SETTLE_READS = 12;
const SETTLE_INTERVAL_MS = 50;

function sameBox(a: TargetBox, b: TargetBox): boolean {
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1
    && Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1;
}

async function viewportSize(page: any): Promise<{ width: number; height: number } | null> {
  try {
    return await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  } catch {
    return null;
  }
}

function insideViewport(box: TargetBox, viewport: { width: number; height: number } | null): boolean {
  if (!viewport) return true;
  return box.x >= 0 && box.y >= 0
    && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
}

/**
 * The target's bounding box once it has stopped moving and lies inside the
 * viewport. Throws, naming the last observed rectangle, when the element has
 * no box or never settles inside the viewport within the read budget.
 */
export async function settledTargetBox(page: any, locator: any): Promise<TargetBox> {
  try { await locator.scrollIntoViewIfNeeded?.(); } catch { /* element may already be in view */ }
  const viewport = await viewportSize(page);
  let previous: TargetBox | null = null;
  let last: TargetBox | null = null;
  for (let read = 0; read < SETTLE_READS; read += 1) {
    const box: TargetBox | null = await locator.boundingBox?.();
    if (!box) throw new Error('humanClickLocator: bounding box unavailable (element detached or off-screen)');
    last = box;
    if (previous && sameBox(previous, box) && insideViewport(box, viewport)) return box;
    previous = box;
    await waitMs(SETTLE_INTERVAL_MS);
  }
  throw new Error(
    'humanClickLocator: target never settled inside the viewport after scrolling; '
    + `last box x=${last?.x} y=${last?.y} w=${last?.width} h=${last?.height}`
    + (viewport ? ` viewport ${viewport.width}x${viewport.height}` : ''),
  );
}
