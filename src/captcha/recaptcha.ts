/**
 * reCAPTCHA v2 Enterprise image challenge solver.
 * Uses CapSolver API for tile classification, with Claude vision as secondary.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { askPage, type ScreenshottablePage } from '../vision/analyze.js';

type Page = any;
const MAX_ATTEMPTS = 15;

const CATEGORY_CODES: Record<string, string> = {
  taxi: '/m/0pg52', taxis: '/m/0pg52', bus: '/m/01bjv', buses: '/m/01bjv',
  'school bus': '/m/02yvhj', motorcycle: '/m/04_sv', motorcycles: '/m/04_sv',
  tractor: '/m/013xlm', tractors: '/m/013xlm', chimney: '/m/01jk_4', chimneys: '/m/01jk_4',
  crosswalk: '/m/014xcs', crosswalks: '/m/014xcs', 'traffic light': '/m/015qff', 'traffic lights': '/m/015qff',
  bicycle: '/m/0199g', bicycles: '/m/0199g', 'parking meter': '/m/015qbp', 'parking meters': '/m/015qbp',
  car: '/m/0k4j', cars: '/m/0k4j', bridge: '/m/015kr', bridges: '/m/015kr',
  boat: '/m/019jd', boats: '/m/019jd', 'palm tree': '/m/0cdl1', 'palm trees': '/m/0cdl1',
  mountain: '/m/09d_r', mountains: '/m/09d_r', 'mountains or hills': '/m/09d_r',
  'fire hydrant': '/m/01pns0', 'fire hydrants': '/m/01pns0',
  stair: '/m/01lynh', stairs: '/m/01lynh',
};

function instructionToCode(instruction: string): string | null {
  const lines = instruction.split('\n').map(l => l.trim()).filter(Boolean);
  for (const line of lines) {
    const clean = line.toLowerCase().replace(/^a\s+/, '');
    if (CATEGORY_CODES[clean]) return CATEGORY_CODES[clean];
  }
  return null;
}

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

async function classifyGrid(bframe: any, instruction: string, gridSize: number): Promise<number[] | null> {
  const gridImgB64 = await bframe.evaluate(`(() => {
    const img = document.querySelector('.rc-image-tile-wrapper img, table.rc-imageselect-table img');
    if (!img) return null;
    const c = document.createElement('canvas'); c.width = img.naturalWidth||img.width; c.height = img.naturalHeight||img.height;
    c.getContext('2d').drawImage(img, 0, 0); return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  })()`).catch(() => null);
  if (!gridImgB64) return null;
  // Save extracted grid for diagnostic comparison with displayed grid
  const diagDir = join(process.cwd(), 'recordings', 'vision');
  mkdirSync(diagDir, { recursive: true });
  writeFileSync(join(diagDir, 'extracted_grid_latest.png'), Buffer.from(gridImgB64, 'base64'));
  // 2captcha GridTask — human workers, ~95% accuracy, ~10-15s
  const { getCaptchaCredentials: getCreds } = await import('../utils/credentials.js');
  const creds = await getCreds();
  const apiKey = creds.twocaptcha ?? '';
  if (apiKey) {
    const comment = instruction.replace(/\n/g, ' ').trim();
    console.log(`[recaptcha] 2captcha: "${comment.slice(0,50)}" ${gridSize}x${gridSize}`);
    const createRes = await (await fetch('https://api.2captcha.com/createTask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, task: { type: 'GridTask', body: gridImgB64, comment, rows: gridSize, columns: gridSize } }),
    })).json() as any;
    if (createRes.taskId) {
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const res = await (await fetch('https://api.2captcha.com/getTaskResult', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: apiKey, taskId: createRes.taskId }),
        })).json() as any;
        if (res.status === 'ready') { console.log(`[recaptcha] 2captcha: ${JSON.stringify(res.solution?.click)}`); return res.solution?.click ?? null; }
        if (res.errorId) { console.log(`[recaptcha] 2captcha error: ${res.errorDescription}`); break; }
      }
    } else { console.log(`[recaptcha] 2captcha create error: ${createRes.errorDescription}`); }
  }
  // CapSolver as secondary (instant AI)
  const capsolverKey = creds.capsolver ?? '';
  const questionCode = instructionToCode(instruction);
  if (capsolverKey && questionCode) {
    const data = await (await fetch('https://api.capsolver.com/createTask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: capsolverKey, task: { type: 'ReCaptchaV2Classification', image: gridImgB64, question: questionCode } }),
    })).json() as any;
    if (data.solution?.objects) { const p = (data.solution.objects as number[]).map(i => i + 1); console.log(`[recaptcha] CapSolver: ${JSON.stringify(p)}`); return p; }
  }
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

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try { // Catch frame detach/navigation as success
    let bframe = findBframe(page);
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
      if (!bframe) { console.log('[recaptcha] Still no bframe'); continue; }
    }

    await bframe.waitForSelector('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical').catch(() => {});
    const instruction = await bframe.evaluate(`(() => { const el = document.querySelector('.rc-imageselect-desc, .rc-imageselect-desc-no-canonical'); return el?.innerText ?? ''; })()`).catch(() => '');
    if (!instruction) { console.log('[recaptcha] Empty instruction, waiting...'); await page.waitForEvent('framenavigated').catch(() => {}); continue; }

    const gridInfo = await bframe.evaluate(`(() => { const t = document.querySelector('table.rc-imageselect-table, table.rc-imageselect-table-33, table.rc-imageselect-table-44'); if (!t) return null; const rows = t.querySelectorAll('tr'); return { cols: rows[0]?.querySelectorAll('td').length || 3 }; })()`).catch(() => null);
    const gridSize = gridInfo?.cols || 3;
    console.log(`[recaptcha] Attempt ${attempt+1}: "${instruction.replace(/\n/g,' ').slice(0,60)}" grid=${gridSize}`);

    // Save diagnostics: page screenshot + extracted grid image for comparison
    const diagDir = join(process.cwd(), 'recordings', 'vision');
    mkdirSync(diagDir, { recursive: true });
    const pageScreenshot = await page.screenshot().catch(() => Buffer.from(''));
    writeFileSync(join(diagDir, `captcha_attempt${attempt}_page.png`), pageScreenshot);

    // Classify tiles via 2captcha/CapSolver (uses extracted grid image from bframe)
    let positions = await classifyGrid(bframe, instruction, gridSize);
    if (positions) console.log(`[recaptcha] Solver: ${JSON.stringify(positions)}`);
    // Claude vision secondary — uses shared askPage() from vision/analyze.ts
    if (!positions) {
      const grid = gridSize === 3 ? '1 2 3\n4 5 6\n7 8 9' : '1  2  3  4\n5  6  7  8\n9  10 11 12\n13 14 15 16';
      const prompt = `reCAPTCHA: "${instruction.replace(/\n/g,' ')}"\nGrid: ${grid}\nReturn ONLY JSON array of positions. Example: [1,4,7]`;
      const answer = await askPage(page as unknown as ScreenshottablePage, prompt, pageScreenshot).catch(() => '');
      positions = parsePositions(answer);
      if (positions) console.log(`[recaptcha] Claude: ${JSON.stringify(positions)}`);
    }
    // Click tiles, then handle dynamic replacement ("click verify once none left")
    const isDynamic = instruction.toLowerCase().includes('none left') || instruction.toLowerCase().includes('verify once');
    let clickRound = 0;
    let clickFailed = false;
    while (positions && positions.length > 0 && !clickFailed) {
      for (const pos of positions) {
        const row = Math.floor((pos - 1) / gridSize) + 1;
        const col = (pos - 1) % gridSize + 1;
        const el = await bframe.$(`table tr:nth-child(${row}) td:nth-child(${col})`);
        if (el) {
          try { await el.click({ force: true }); console.log(`[recaptcha] Tile ${pos}`); }
          catch { console.log(`[recaptcha] Tile ${pos} stalled — clicking verify`); clickFailed = true; break; }
        }
        await page.waitForTimeout(300 + Math.floor(Math.random() * 300));
      }
      if (!isDynamic || clickRound >= 5 || clickFailed) break;
      await page.waitForTimeout(2000);
      positions = await classifyGrid(bframe, instruction, gridSize);
      console.log(`[recaptcha] Round ${clickRound+2}: ${JSON.stringify(positions)}`);
      clickRound++;
    }
    await page.waitForTimeout(500);

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
      console.log(`[recaptcha] Loop error: ${loopErr.message?.slice(0, 80)}`);
    }
  }
  console.log('[recaptcha] Failed after max attempts');
  return false;
}
