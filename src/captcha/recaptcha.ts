/**
 * reCAPTCHA v2 Enterprise image challenge solver.
 * The tile classifiers and their consensus live in `./grid/`; this file
 * drives the challenge itself.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { askPage, type ScreenshottablePage } from '../vision/analyze.js';
import { pageSettled } from '../browser/settled.js';
import { runRecordingsDir } from '../session/run-recordings.js';
import { classifyGrid } from './grid/classify_grid.js';

type Page = any;
// No attempt cap: blind retries trip LinkedIn's login restriction.

function parsePositions(raw: string): number[] | null {
  const m = raw.match(/\[[\d,\s]*\]/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

function findBframe(page: Page) {
  for (const f of page.frames()) {
    if ((f.url?.() ?? '').includes('/bframe')) return f;
  }
  return null;
}

function findAnchorFrame(page: Page) {
  for (const f of page.frames()) {
    if ((f.url?.() ?? '').includes('/anchor')) return f;
  }
  return null;
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
      return { instruction: el.innerText ?? '', cols };
    }
    return null;
  })()`);
  if (!visible) return null;
  if (visible.loading) return { kind: 'loading' };
  if (!visible.instruction.trim())
    throw new Error(
      'RECAPTCHA_INSTRUCTION_EMPTY: the visible image challenge has no instruction',
    );
  if (visible.cols !== 3 && visible.cols !== 4)
    throw new Error(
      `RECAPTCHA_GRID_UNSUPPORTED: observed ${visible.cols} columns`,
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
  {
    const attempt = 0;
    const bframe = entry.frame;
    const instruction = entry.instruction;

    const gridSize = entry.gridSize;
    console.log(
      `[recaptcha] Attempt ${attempt + 1}: "${instruction.replace(/\n/g, ' ')}" grid=${gridSize}`,
    );

    // Save diagnostics: page screenshot + extracted grid image for comparison
    const diagDir = runRecordingsDir('vision'); // G17: recordings/<run_uuid>/vision/
    mkdirSync(diagDir, { recursive: true });
    const pageScreenshot = await page.screenshot();
    writeFileSync(
      join(diagDir, `captcha_attempt${attempt}_page.png`),
      pageScreenshot,
    );

    // Classify tiles via 2captcha/CapSolver (uses extracted grid image from bframe)
    let positions = await classifyGrid(bframe, instruction, gridSize);
    if (positions)
      console.log(`[recaptcha] Solver: ${JSON.stringify(positions)}`);
    // Authenticated Stado-routed vision fallback.
    if (!positions) {
      const grid =
        gridSize === 3
          ? '1 2 3\n4 5 6\n7 8 9'
          : '1  2  3  4\n5  6  7  8\n9  10 11 12\n13 14 15 16';
      const prompt = `reCAPTCHA: "${instruction.replace(/\n/g, ' ')}"\nGrid: ${grid}\nReturn ONLY JSON array of positions. Example: [1,4,7]`;
      const answer = await askPage(
        page as unknown as ScreenshottablePage,
        prompt,
        pageScreenshot,
      ).catch(() => '');
      positions = parsePositions(answer);
      if (positions)
        console.log(`[recaptcha] Model: ${JSON.stringify(positions)}`);
    }
    // Click each tile once. No re-classify-and-click loop on dynamic
    // replacement — that's another retry pattern that just burns budget.
    if (positions && positions.length > 0) {
      for (const pos of positions) {
        const row = Math.floor((pos - 1) / gridSize) + 1;
        const col = ((pos - 1) % gridSize) + 1;
        try {
          await bframe
            .locator(`table tr:nth-child(${row}) td:nth-child(${col})`)
            .click({ force: true });
          console.log(`[recaptcha] Tile ${pos}`);
        } catch (e: any) {
          throw new Error(
            `RECAPTCHA_TILE_CLICK_FAILED: tile ${pos}: ${e.message}`,
            { cause: e },
          );
        }
        await pageSettled(bframe);
      }
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
          console.log(`[recaptcha] Solved in ${attempt + 1} attempts!`);
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
}
