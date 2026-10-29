/**
 * reCAPTCHA v2 Enterprise image challenge solver.
 * The tile classifiers and their consensus live in `./grid/`; this file
 * drives the challenge itself. Tiles are numbered from zero, left to right
 * and top to bottom, the order the challenge table lists its cells in.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { askPage, type ScreenshottablePage } from '../vision/analyze.js';
import { pageSettled } from '../browser/settled.js';
import { runRecordingsDir } from '../session/run-recordings.js';
import { classifyGrid } from './grid/classify_grid.js';
import { parsedTiles, tileLabels } from './grid/consensus.js';

type Page = any;
// No attempt cap: blind retries trip LinkedIn's login restriction.

/** The page's frame whose address holds `part`, if one does. */
function frameAt(page: Page, part: string) {
  for (const f of page.frames()) {
    if (f.url().includes(part)) return f;
  }
  return null;
}

function findBframe(page: Page) {
  return frameAt(page, '/bframe');
}

function findAnchorFrame(page: Page) {
  return frameAt(page, '/anchor');
}

type ChallengeEntry =
  | { kind: 'solved' }
  | { kind: 'loading' }
  | { kind: 'ready'; frame: Page; instruction: string; gridSize: number };

async function readChallengeEntry(page: Page): Promise<ChallengeEntry | null> {
  const anchor = findAnchorFrame(page);
  if (
    anchor &&
    (await anchor.evaluate(
      `(() => document.querySelector('.recaptcha-checkbox')?.getAttribute('aria-checked') === 'true')()`,
    ))
  )
    return { kind: 'solved' };
  const frame = findBframe(page);
  if (!frame) return null;
  const visible = await frame.evaluate(`(() => {
    for (const el of document.querySelectorAll('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical')) {
      if (el.offsetParent === null || getComputedStyle(el).visibility === 'hidden') continue;
      const table = document.querySelector('table.rc-imageselect-table, table.rc-imageselect-table-33, table.rc-imageselect-table-44');
      if (!table || table.offsetParent === null) return { loading: true };
      const cols = table.querySelector('tr')?.querySelectorAll('td').length;
      if (!cols) return { loading: true };
      let loading = false;
      for (const image of table.querySelectorAll('img')) {
        if (!image.complete) loading = true;
        else if (!image.naturalWidth) throw new Error('RECAPTCHA_IMAGE_LOAD_FAILED: ' + (image.currentSrc || image.src));
      }
      if (loading) return { loading: true };
      return { instruction: el.innerText, cols };
    }
    return null;
  })()`);
  if (!visible) return null;
  if (visible.loading) return { kind: 'loading' };
  if (!visible.instruction?.trim())
    throw new Error(
      'RECAPTCHA_INSTRUCTION_EMPTY: the visible image challenge has no instruction',
    );
  return {
    kind: 'ready',
    frame,
    instruction: visible.instruction,
    gridSize: visible.cols,
  };
}

export async function solveRecaptchaV2(page: Page): Promise<boolean> {
  console.log('[recaptcha] Starting solver...');

  let entry = await readChallengeEntry(page);
  if (!entry) {
    const ci = page.frameLocator('iframe[src*="captchaInternal"]');
    await ci
      .frameLocator('iframe[src*="anchor"]')
      .first()
      .locator('#recaptcha-anchor')
      .click();
    console.log('[recaptcha] Clicked checkbox');
  }
  while (!entry || entry.kind === 'loading') {
    await pageSettled(page);
    entry = await readChallengeEntry(page);
  }
  if (entry.kind === 'solved') {
    console.log('[recaptcha] Auto-passed!');
    return true;
  }

  // Single-shot solve. No retry on verify-reject — burning budget on the
  // same image + flagged session just trips LinkedIn login-restriction.
  const bframe = entry.frame;
  const instruction = entry.instruction.replace(/\n/g, ' ');
  const gridSize = entry.gridSize;
  console.log(`[recaptcha] Challenge: "${instruction}" grid=${gridSize}`);

  // Save diagnostics: page screenshot + extracted grid image for comparison
  const diagDir = runRecordingsDir('vision');
  mkdirSync(diagDir, { recursive: true });
  const pageScreenshot = await page.screenshot();
  writeFileSync(join(diagDir, 'captcha_challenge_page.png'), pageScreenshot);

  let positions = await classifyGrid(bframe, entry.instruction, gridSize);
  if (positions) console.log(`[recaptcha] Solver: ${JSON.stringify(positions)}`);
  // No voter answered: the authenticated Stado-routed vision model reads the
  // whole page; its failure ends the solve with its cause.
  if (!positions) {
    const prompt = `reCAPTCHA: "${instruction}"\nTiles, labelled row by row:\n${tileLabels(gridSize, '\n')}\nReturn ONLY a JSON array of the labels of the matching tiles.`;
    positions = parsedTiles(
      await askPage(page as unknown as ScreenshottablePage, prompt, pageScreenshot),
    );
    console.log(`[recaptcha] Model: ${JSON.stringify(positions)}`);
  }
  // Click each tile once. No re-classify-and-click loop on dynamic
  // replacement — that's another retry pattern that just burns budget.
  const tiles = bframe.locator('table td');
  for (const tile of positions) {
    try {
      await tiles.nth(tile).click({ force: true });
      console.log(`[recaptcha] Tile ${tile}`);
    } catch (e: any) {
      throw new Error(`RECAPTCHA_TILE_CLICK_FAILED: tile ${tile}: ${e.message}`, { cause: e });
    }
    await pageSettled(bframe);
  }

  const verifyEl = bframe.locator('#recaptcha-verify-button');
  await verifyEl.waitFor({ state: 'visible' });
  if (!(await verifyEl.isEnabled()))
    throw new Error(
      'RECAPTCHA_VERIFY_DISABLED: the provider has not enabled verification',
    );
  await verifyEl.click({ force: true });
  console.log('[recaptcha] Verify clicked');

  // Read the actual outcome; the unchanged instruction is not a response.
  for (;;) {
    const af = findAnchorFrame(page);
    if (af) {
      const solved = await af.evaluate(
        `(() => document.querySelector('.recaptcha-checkbox')?.getAttribute('aria-checked') === 'true')()`,
      );
      if (solved) {
        console.log('[recaptcha] Solved');
        return true;
      }
    }
    const observedFrame = findBframe(page);
    if (!observedFrame)
      throw new Error(
        'RECAPTCHA_OUTCOME_UNOBSERVED: the challenge frame disappeared before a checked anchor was observed',
      );
    const err = await observedFrame.evaluate(
      `(() => { for (const e of document.querySelectorAll('.rc-imageselect-error-select-more, .rc-imageselect-incorrect-response')) { if (e.offsetParent !== null) return { message: e.textContent, state: e.className }; } return null; })()`,
    );
    if (err)
      throw new Error(`RECAPTCHA_REJECTED: ${err.message || err.state}`);
    await pageSettled(observedFrame);
  }
}
