// A scroll request is not evidence that its target has stopped moving.
// Read geometry across rendered frames, not after a guessed delay. A stable
// rectangle outside the viewport is a refusal, not permission to click it.

export interface TargetBox { x: number; y: number; width: number; height: number }

function sameBox(a: TargetBox, b: TargetBox): boolean {
  return a.x === b.x && a.y === b.y
    && a.width === b.width && a.height === b.height;
}

async function viewportSize(page: any): Promise<{ width: number; height: number }> {
  try {
    return await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  } catch (error) {
    throw new Error(`humanClickLocator: reading viewport failed: ${String(error)}`, { cause: error });
  }
}

function insideViewport(box: TargetBox, viewport: { width: number; height: number }): boolean {
  return box.x >= 0 && box.y >= 0
    && box.x + box.width <= viewport.width && box.y + box.height <= viewport.height;
}

/**
 * Read the target across browser frames until its geometry stops changing.
 * Moving geometry stays pending; missing or stationary off-screen geometry,
 * scroll failures and viewport-read failures are reported directly.
 */
export async function settledTargetBox(page: any, locator: any): Promise<TargetBox> {
  try {
    await locator.scrollIntoViewIfNeeded?.();
  } catch (error) {
    throw new Error(`humanClickLocator: scrolling target failed: ${String(error)}`, { cause: error });
  }
  let previous: TargetBox | null = null;
  for (;;) {
    const box: TargetBox | null = await locator.boundingBox?.();
    if (!box) throw new Error('humanClickLocator: bounding box unavailable (element detached or off-screen)');
    if (previous && sameBox(previous, box)) {
      const viewport = await viewportSize(page);
      if (insideViewport(box, viewport)) return box;
      throw new Error(
        'humanClickLocator: stationary target is outside the viewport after the scroll request; '
        + `box x=${box.x} y=${box.y} w=${box.width} h=${box.height}`
        + ` viewport ${viewport.width}x${viewport.height}`,
      );
    }
    previous = box;
    await page.evaluate(() => new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    }));
  }
}
