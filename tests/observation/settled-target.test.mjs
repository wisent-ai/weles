/**
 * A click target is the box the element rests at, not the box it passes
 * through while its container is still scrolling.
 *
 * On 2026-09-10 the featured-character journey on app.wisent.com clicked
 * "Chat with Victoria Lane" six times and navigated nowhere: the tile sat
 * off the right edge of a lane styled `scroll-behavior: smooth`,
 * `scrollIntoViewIfNeeded` returned as soon as the scroll was requested,
 * and the bounding box read in the next millisecond was the tile's
 * pre-scroll position — under which some other card was drawn.
 *
 * The page and locator here answer the way a smooth-scrolling lane does:
 * the box moves for several reads and then rests inside the viewport, or
 * never rests there at all.
 *
 * Run: node --test tests/observation/settled-target.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const { settledTargetBox } = require(resolve(import.meta.dirname, '../../dist/human/pointer/target-box.js'));

const VIEWPORT = { width: 1680, height: 1050 };
const page = { evaluate: async () => VIEWPORT };

/** A lane tile whose box moves through the given positions, one per read. */
function tile(positions) {
  let reads = 0;
  return {
    scrolled: 0,
    async scrollIntoViewIfNeeded() { this.scrolled += 1; },
    async boundingBox() {
      const position = positions[Math.min(reads, positions.length - 1)];
      reads += 1;
      return { x: position, y: 320, width: 185, height: 248 };
    },
  };
}

test('a tile still sliding into view is clicked where it rests, not where it started', async () => {
  const sliding = tile([1900, 1500, 1100, 700, 700, 700]);
  const box = await settledTargetBox(page, sliding);
  assert.equal(sliding.scrolled, 1, 'the target is scrolled into view once');
  assert.equal(box.x, 700, 'the resting position is the click target');
  assert.ok(box.x + box.width <= VIEWPORT.width, 'the resting box lies inside the viewport');
});

test('a tile that never rests inside the viewport is refused by name, not clicked', async () => {
  const stuck = tile([1900]);
  await assert.rejects(
    () => settledTargetBox(page, stuck),
    (error) => {
      assert.match(error.message, /never settled inside the viewport/);
      assert.match(error.message, /x=1900/);
      assert.match(error.message, /viewport 1680x1050/);
      return true;
    },
  );
});

test('a detached element is refused before any pointer movement', async () => {
  const detached = { async scrollIntoViewIfNeeded() {}, async boundingBox() { return null; } };
  await assert.rejects(() => settledTargetBox(page, detached), /bounding box unavailable/);
});
