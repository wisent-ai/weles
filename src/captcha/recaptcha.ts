/**
 * reCAPTCHA v2 Enterprise image challenge solver.
 * The tile classifiers and their consensus live in `./grid/`; this file
 * drives the challenge itself.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { askPage, type ScreenshottablePage } from '../vision/analyze.js';
import { humanIdlePause } from '../human/mouse.js';
import { runRecordingsDir } from '../session/run-recordings.js';
import { classifyGrid } from './grid/classify_grid.js';

type Page = any;
// MAX_ATTEMPTS removed 2026-05-06: blind retries trip LinkedIn login-restriction.

function parsePositions(raw: string): number[] | null {
  const m = raw.match(/\[[\d,\s]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function findBframe(page: Page) {
  for (const f of page.frames()) { if ((f.url?.() ?? '').includes('/bframe')) return f; }
  return null;
}

function findAnchorFrame(page: Page) {
  for (const f of page.frames()) { if ((f.url?.() ?? '').includes('/anchor')) return f; }
  return null;
}


export async function solveRecaptchaV2(page: Page): Promise<boolean> {
  console.log('[recaptcha] Starting solver...');

  // Click checkbox if image challenge not already open
  const existingBframe = findBframe(page);
  const hasGrid = existingBframe ? await existingBframe.evaluate(`(() => !!document.querySelector('.rc-imageselect-desc'))()`).catch(() => false) : false;
  if (!hasGrid) {
    try {
      const ci = page.frameLocator('iframe[src*="captchaInternal"]');
      await ci.frameLocator('iframe[src*="anchor"]').first().locator('#recaptcha-anchor').click();
      console.log('[recaptcha] Clicked checkbox');
    } catch (e: any) { console.log('[recaptcha] Checkbox failed:', e.message?.slice(0, 60)); return false; }
    const af = findAnchorFrame(page);
    if (af) {
      const checked = await af.evaluate(`(() => document.querySelector('.recaptcha-checkbox')?.getAttribute('aria-checked') === 'true')()`).catch(() => false);
      if (checked) { console.log('[recaptcha] Auto-passed!'); return true; }
    }
    await page.waitForEvent('frameattached').catch(() => {});
  }

  // Use frameLocator chain for clicking (trusted events through nested iframes)
  const ci = page.frameLocator('iframe[src*="captchaInternal"]');
  const bf = ci.frameLocator('iframe[src*="bframe"]').first();

  // Single-shot solve. No retry on verify-reject — burning budget on the
  // same image + flagged session just trips LinkedIn login-restriction.
  {
    const attempt = 0;
    try {
    let bframe = findBframe(page);
    // Anchor-state recovery (restored 2026-05-08 from frame_5a0be1ec_last.png
    // showing "Verification challenge expired" + aria-checked=false).
    try {
      const af = findAnchorFrame(page);
      if (af) {
        const checked = await af.evaluate(`(() => document.querySelector('.recaptcha-checkbox')?.getAttribute('aria-checked') === 'true')()`).catch(() => false);
        if (!checked && bframe) {
          console.log('[recaptcha] Anchor unchecked (token expired) — re-clicking');
          try { await af.locator('#recaptcha-anchor').click({ force: true }); } catch {}
          await page.waitForEvent('frameattached', { timeout: 5000 }).catch(() => {});
          await humanIdlePause('short');
          bframe = findBframe(page);
        }
      }
    } catch {}
    if (!bframe) {
      // Page may have navigated to new checkpoint — wait for it to load
      console.log('[recaptcha] No bframe, waiting for page load...');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      // Re-click checkbox on new checkpoint page
      try {
        const ci2 = page.frameLocator('iframe[src*="captchaInternal"]');
        await ci2.frameLocator('iframe[src*="anchor"]').first().locator('#recaptcha-anchor').click();
        console.log('[recaptcha] Re-clicked checkbox');
        await page.waitForEvent('frameattached').catch(() => {});
      } catch {}
      bframe = findBframe(page);
      if (!bframe) { console.log('[recaptcha] Still no bframe — failing fast'); return false; }
    }

    await bframe.waitForSelector('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical').catch(() => {});
    const instruction = await bframe.evaluate(`(() => { const el = document.querySelector('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical'); return el?.innerText ?? ''; })()`).catch(() => '');
    if (!instruction) { console.log('[recaptcha] Empty instruction — failing fast'); return false; }

    const gridInfo = await bframe.evaluate(`(() => { const t = document.querySelector('table.rc-imageselect-table, table.rc-imageselect-table-33, table.rc-imageselect-table-44'); if (!t) return null; const rows = t.querySelectorAll('tr'); return { cols: rows[0]?.querySelectorAll('td').length || 3 }; })()`).catch(() => null);
    const gridSize = gridInfo?.cols || 3;
    console.log(`[recaptcha] Attempt ${attempt+1}: "${instruction.replace(/\n/g,' ').slice(0,60)}" grid=${gridSize}`);

    // Save diagnostics: page screenshot + extracted grid image for comparison
    const diagDir = runRecordingsDir('vision'); // G17: recordings/<run_uuid>/vision/
    mkdirSync(diagDir, { recursive: true });
    const pageScreenshot = await page.screenshot().catch(() => Buffer.from(''));
    writeFileSync(join(diagDir, `captcha_attempt${attempt}_page.png`), pageScreenshot);

    // Classify tiles via 2captcha/CapSolver (uses extracted grid image from bframe)
    let positions = await classifyGrid(bframe, instruction, gridSize);
    if (positions) console.log(`[recaptcha] Solver: ${JSON.stringify(positions)}`);
    // Authenticated Stado-routed vision fallback.
    if (!positions) {
      const grid = gridSize === Number('3') ? '1 2 3\n4 5 6\n7 8 9' : '1  2  3  4\n5  6  7  8\n9  10 11 12\n13 14 15 16';
      const prompt = `reCAPTCHA: "${instruction.replace(/\n/g,' ')}"\nGrid: ${grid}\nReturn ONLY JSON array of positions. Example: [1,4,7]`;
      const answer = await askPage(page as unknown as ScreenshottablePage, prompt, pageScreenshot).catch(() => '');
      positions = parsePositions(answer);
      if (positions) console.log(`[recaptcha] Model: ${JSON.stringify(positions)}`);
    }
    // Click each tile once. No re-classify-and-click loop on dynamic
    // replacement — that's another retry pattern that just burns budget.
    if (positions && positions.length > 0) {
      for (const pos of positions) {
        const row = Math.floor((pos - 1) / gridSize) + 1;
        const col = (pos - 1) % gridSize + 1;
        try {
          await bf.locator(`table tr:nth-child(${row}) td:nth-child(${col})`).click({ force: true });
          console.log(`[recaptcha] Tile ${pos}`);
        } catch (e: any) {
          console.log(`[recaptcha] Tile ${pos} stalled (${e.message?.slice(0,40)})`);
          break;
        }
        await humanIdlePause();
      }
    }
    await humanIdlePause('short');

    // Click verify
    const verifyEl = await bframe.$('#recaptcha-verify-button');
    if (verifyEl) { await verifyEl.click({ force: true }); console.log('[recaptcha] Verify clicked'); }
    else { await bframe.evaluate(`(() => document.querySelector('#recaptcha-verify-button')?.click())()`).catch(() => {}); console.log('[recaptcha] Verify JS'); }

    // Wait for result — context destroyed = page navigated = solved
    try {
      await bframe.waitForFunction(`() => {
        const err = document.querySelector('.rc-imageselect-error-select-more, .rc-imageselect-incorrect-response');
        return (err && err.offsetParent !== null) || document.querySelector('.rc-imageselect-desc');
      }`);
    } catch (e: any) {
      if (e.message?.includes('context') || e.message?.includes('destroy') || e.message?.includes('navig') || e.message?.includes('detach')) {
        console.log('[recaptcha] Page navigated — SOLVED!'); return true;
      }
    }

    // Check checkbox
    try {
      const af = findAnchorFrame(page);
      if (af) {
        const solved = await af.evaluate(`(() => document.querySelector('.recaptcha-checkbox')?.getAttribute('aria-checked') === 'true')()`).catch(() => false);
        if (solved) { console.log(`[recaptcha] Solved in ${attempt+1} attempts!`); return true; }
      }
    } catch { console.log('[recaptcha] Context lost — likely solved'); return true; }

    const err = await bframe.evaluate(`(() => { const e = document.querySelector('.rc-imageselect-error-select-more, .rc-imageselect-incorrect-response'); return e?.offsetParent ? e.textContent : null; })()`).catch(() => null);
    if (err) console.log(`[recaptcha] Error: ${err}`);
    } catch (loopErr: any) {
      if (loopErr.message?.includes('detach') || loopErr.message?.includes('context') || loopErr.message?.includes('destroy')) {
        console.log('[recaptcha] Frame detached — SOLVED!'); return true;
      }
      console.log(`[recaptcha] Single-shot error: ${loopErr.message?.slice(0, 80)}`);
    }
  }
  console.log('[recaptcha] Single-shot did not solve — failing fast');
  return false;
}
