/**
 * reCAPTCHA v2 Enterprise image challenge solver using Claude vision.
 * Port of account-api-build/skills/captcha/recaptcha/_recaptcha_challenge.py
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

type Page = any;
const MAX_ATTEMPTS = 8;

// reCAPTCHA category codes for CapSolver API
const CATEGORY_CODES: Record<string, string> = {
  taxi: '/m/0pg52', taxis: '/m/0pg52', bus: '/m/01bjv', buses: '/m/01bjv',
  'school bus': '/m/02yvhj', motorcycle: '/m/04_sv', motorcycles: '/m/04_sv',
  tractor: '/m/013xlm', tractors: '/m/013xlm', chimney: '/m/01jk_4', chimneys: '/m/01jk_4',
  crosswalk: '/m/014xcs', crosswalks: '/m/014xcs', 'traffic light': '/m/015qff', 'traffic lights': '/m/015qff',
  bicycle: '/m/0199g', bicycles: '/m/0199g', 'parking meter': '/m/015qbp', 'parking meters': '/m/015qbp',
  car: '/m/0k4j', cars: '/m/0k4j', bridge: '/m/015kr', bridges: '/m/015kr',
  boat: '/m/019jd', boats: '/m/019jd', 'palm tree': '/m/0cdl1', 'palm trees': '/m/0cdl1',
  mountain: '/m/09d_r', mountains: '/m/09d_r', hill: '/m/09d_r', hills: '/m/09d_r',
  'mountains or hills': '/m/09d_r', 'fire hydrant': '/m/01pns0', 'fire hydrants': '/m/01pns0',
  stair: '/m/01lynh', stairs: '/m/01lynh',
};

function instructionToCode(instruction: string): string | null {
  const text = instruction.toLowerCase().replace(/select all (images|squares) with\s*/i, '').replace(/\n/g, ' ').replace(/a\s+/g, '').trim();
  return CATEGORY_CODES[text] ?? null;
}

function buildPrompt(instruction: string, gridSize: number): string {
  const grid = gridSize === 3 ? '1 2 3\n4 5 6\n7 8 9' : '1  2  3  4\n5  6  7  8\n9  10 11 12\n13 14 15 16';
  return `You are solving a reCAPTCHA image challenge. Look at the image grid and identify which squares contain the target object.

TARGET OBJECT: "${instruction}"

The grid is numbered like this (left-to-right, top-to-bottom):
${grid}

CRITICAL RULES FOR HIGH ACCURACY:
1. INCLUDE any square where you can see ANY part of the target object, even tiny portions
2. Objects often span multiple squares - select ALL squares the object touches
3. Look carefully at edges and corners of each square
4. Common objects and what to look for:
   - Bicycles: wheels, handlebars, frames, pedals - include ALL squares with any bike part
   - Cars: Include entire vehicle even if wheels are in different squares
   - Buses: Large vehicles - usually span 4-6 squares horizontally
   - Traffic lights: Include the entire pole AND the signal head
   - Crosswalks: White stripes on road - select ALL squares with visible stripes
   - Fire hydrants: Red/yellow objects on sidewalks
   - Stairs: Steps going up or down, indoor or outdoor
5. When instruction says "click verify once there are none left" and you see NO targets, return []
6. BE THOROUGH: Missing a square fails the challenge. Extra squares are okay.

RESPOND WITH ONLY A VALID JSON ARRAY. Examples: [1,4,7] or [2,5,6,9] or []
No explanations. No markdown. No text before or after the array.`;
}

function parsePositions(raw: string): number[] | null {
  const m = raw.match(/\[[\d,\s]*\]/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

function findBframe(page: Page) {
  for (const f of page.frames()) {
    const url = f.url?.() ?? '';
    if (url.includes('/bframe')) return f;
  }
  return null;
}

function findAnchorFrame(page: Page) {
  for (const f of page.frames()) {
    if ((f.url?.() ?? '').includes('/anchor')) return f;
  }
  return null;
}

export async function solveRecaptchaV2(page: Page): Promise<boolean> {
  console.log('[recaptcha] Looking for reCAPTCHA iframes...');
  console.log('[recaptcha] All frame URLs:', page.frames().map((f: any) => f.url?.()?.slice(0, 80)));

  // Check if bframe (image challenge) is already visible
  let bframeReady = !!findBframe(page);
  if (!bframeReady) {
    // Click checkbox via frameLocator chain (pierces nested iframes)
    try {
      const ci = page.frameLocator('iframe[src*="captchaInternal"]');
      const rc = ci.frameLocator('iframe[src*="anchor"]').first();
      await rc.locator('#recaptcha-anchor').click();
      console.log('[recaptcha] Clicked checkbox');
    } catch (e: any) { console.log('[recaptcha] Checkbox click failed:', e.message?.slice(0, 100)); return false; }

    // Check auto-pass
    const anchorFrame = findAnchorFrame(page);
    if (anchorFrame) {
      const checked = await anchorFrame.evaluate(`(() => { const c = document.querySelector('.recaptcha-checkbox'); return c?.getAttribute('aria-checked') === 'true'; })()`).catch(() => false);
      if (checked) { console.log('[recaptcha] Auto-passed!'); return true; }
    }
    // Wait for bframe
    await page.waitForEvent('frameattached').catch(() => {});
  } else {
    console.log('[recaptcha] Image challenge already visible, skipping checkbox');
  }
  console.log('[recaptcha] Frames after checkbox:', page.frames().map((f: any) => f.url?.()?.slice(0, 80)));

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const bframe = findBframe(page);
    if (!bframe) { console.log('[recaptcha] No bframe, waiting...'); await page.waitForEvent('frameattached').catch(() => {}); continue; }

    // Wait for grid to render inside bframe
    await bframe.waitForSelector('table.rc-imageselect-table, table.rc-imageselect-table-33, table.rc-imageselect-table-44').catch(() => {});

    const instruction = await bframe.evaluate(`(() => { const el = document.querySelector('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical, .rc-imageselect-desc-wrapper'); return el ? el.innerText : ''; })()`).catch(() => '');
    console.log(`[recaptcha] Attempt ${attempt + 1}/${MAX_ATTEMPTS}: "${instruction.slice(0, 80)}"`);

    const gridInfo = await bframe.evaluate(`(() => { const t = document.querySelector('table.rc-imageselect-table, table.rc-imageselect-table-33, table.rc-imageselect-table-44'); if (!t) return null; const rows = t.querySelectorAll('tr'); return { rows: rows.length, cols: rows[0]?.querySelectorAll('td').length || 0 }; })()`).catch(() => null);
    const gridSize = gridInfo?.cols || 3;

    // Screenshot just the bframe challenge popup (it's a separate floating iframe)
    let screenshot: Buffer;
    try {
      // The bframe renders as a separate overlay iframe on the main page
      const allIframes = await page.$$('iframe');
      let bframeEl = null;
      for (const iframe of allIframes) {
        const src = await iframe.getAttribute('src').catch(() => '') ?? '';
        if (src.includes('/bframe')) { bframeEl = iframe; break; }
      }
      // Also check inside captchaInternal for nested bframe
      if (!bframeEl) {
        const ciFrame = page.frames().find((f: any) => (f.url?.() ?? '').includes('captchaInternal'));
        if (ciFrame) { bframeEl = await ciFrame.$('iframe[src*="bframe"]'); }
      }
      if (bframeEl) {
        screenshot = await bframeEl.screenshot();
        console.log(`[recaptcha] Bframe element screenshot: ${screenshot.length} bytes`);
      } else { screenshot = await page.screenshot(); console.log('[recaptcha] Using full page screenshot'); }
    } catch { screenshot = await page.screenshot(); }
    const imgPath = join(process.cwd(), 'recordings', 'vision', `captcha_attempt${attempt}.png`);
    writeFileSync(imgPath, screenshot);
    console.log(`[recaptcha] Screenshot: ${screenshot.length} bytes`);

    // Use CapSolver API for image classification, or Claude vision as secondary
    const capsolverKey = process.env.CAPSOLVER_API_KEY ?? '';
    const imgB64 = screenshot.toString('base64');
    let positions: number[] | null = null;
    const questionCode = instructionToCode(instruction);
    if (capsolverKey && questionCode) {
      try {
        console.log(`[recaptcha] CapSolver: code=${questionCode} for "${instruction.slice(0, 40)}"`);
        const res = await fetch('https://api.capsolver.com/createTask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: capsolverKey, task: { type: 'ReCaptchaV2Classification', image: imgB64, question: questionCode } }),
        });
        const data = await res.json() as any;
        console.log(`[recaptcha] CapSolver response: ${JSON.stringify(data).slice(0, 200)}`);
        if (data.solution?.objects) {
          // objects is array of indices (0-based) of matching tiles
          positions = (data.solution.objects as number[]).map(i => i + 1);
        } else if (data.errorDescription) console.log(`[recaptcha] CapSolver error: ${data.errorDescription}`);
      } catch (e: any) { console.log(`[recaptcha] CapSolver API error: ${e.message?.slice(0, 80)}`); }
    }
    if (!positions) {
      const prompt = buildPrompt(instruction, gridSize);
      const cliPrompt = `Read the captcha image at ${imgPath}.\n\n${prompt}`;
      let answer = '';
      try {
        const proc = spawnSync('claude', ['-p', '--output-format', 'json'], { input: cliPrompt, encoding: 'utf-8', maxBuffer: 5 * 1024 * 1024 });
        answer = (proc.stdout ?? '').trim();
        for (const line of answer.split('\n')) { try { const j = JSON.parse(line); if (j.result) { answer = j.result; break; } } catch { /* skip */ } }
      } catch (e: any) { console.log(`[recaptcha] Claude error: ${e.message?.slice(0, 80)}`); }
      positions = parsePositions(answer);
    }
    console.log(`[recaptcha] Claude selected: ${JSON.stringify(positions)}`);
    if (!positions) continue;

    // Click tiles via page.mouse at absolute coordinates (proper mouse events)
    // Find the bframe element handle for bounding box offset
    let clickFrameEl = null;
    for (const iframe of await page.$$('iframe')) {
      if (((await iframe.getAttribute('src').catch(() => '')) ?? '').includes('/bframe')) { clickFrameEl = iframe; break; }
    }
    const ciBox = clickFrameEl ? await clickFrameEl.boundingBox() : null;
    for (const pos of positions) {
      const row = Math.floor((pos - 1) / gridSize) + 1;
      const col = (pos - 1) % gridSize + 1;
      const tilePos = await bframe.evaluate(`(() => { const t = document.querySelector('table.rc-imageselect-table, table.rc-imageselect-table-33, table.rc-imageselect-table-44'); const td = t?.querySelector('tr:nth-child(${row}) td:nth-child(${col})'); if (!td) return null; const r = td.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`).catch(() => null);
      if (tilePos && ciBox) {
        await page.mouse.click(ciBox.x + tilePos.x, ciBox.y + tilePos.y);
        console.log(`[recaptcha] Clicked tile ${pos} at (${(ciBox.x + tilePos.x).toFixed(0)}, ${(ciBox.y + tilePos.y).toFixed(0)})`);
      } else {
        await bframe.evaluate(`(() => { const t = document.querySelector('table.rc-imageselect-table, table.rc-imageselect-table-33, table.rc-imageselect-table-44'); const td = t?.querySelector('tr:nth-child(${row}) td:nth-child(${col})'); if (td) td.click(); })()`).catch(() => {});
        console.log(`[recaptcha] Clicked tile ${pos} (JS)`);
      }
    }

    // Click verify via absolute coordinates
    const verifyPos = await bframe.evaluate(`(() => { const b = document.querySelector('#recaptcha-verify-button'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`).catch(() => null);
    if (verifyPos && ciBox) { await page.mouse.click(ciBox.x + verifyPos.x, ciBox.y + verifyPos.y); }
    else { await bframe.evaluate(`(() => { const b = document.querySelector('#recaptcha-verify-button'); if (b) b.click(); })()`).catch(() => {}); }
    console.log('[recaptcha] Clicked verify');

    // Wait for result: either checkbox checked, new challenge, or error
    await bframe.waitForFunction(`() => {
      const err = document.querySelector('.rc-imageselect-error-select-more, .rc-imageselect-incorrect-response');
      const newChallenge = document.querySelector('.rc-imageselect-desc');
      return (err && err.offsetParent !== null) || newChallenge;
    }`).catch(() => {});

    // Check solved
    const af = findAnchorFrame(page);
    if (af) {
      const solved = await af.evaluate(`(() => { const c = document.querySelector('.recaptcha-checkbox'); return c?.getAttribute('aria-checked') === 'true'; })()`).catch(() => false);
      if (solved) { console.log(`[recaptcha] Solved in ${attempt + 1} attempts!`); return true; }
    }

    const error = await bframe.evaluate(`(() => { const e = document.querySelector('.rc-imageselect-error-select-more, .rc-imageselect-incorrect-response'); return e?.offsetParent !== null ? e.textContent : null; })()`).catch(() => null);
    if (error) console.log(`[recaptcha] Error: ${error}`);
  }
  console.log('[recaptcha] Failed after max attempts');
  return false;
}
