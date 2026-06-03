/**
 * reCAPTCHA v2 Enterprise image challenge solver.
 * Uses CapSolver API for tile classification, with Claude vision as secondary.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { askPage, type ScreenshottablePage } from '../vision/analyze.js';
import { humanIdlePause } from '../human/mouse.js';
import { runRecordingsDir } from '../session/run-recordings.js';

type Page = any;
// MAX_ATTEMPTS removed 2026-05-06: blind retries trip LinkedIn login-restriction.

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
  // Match category word(s) anywhere in instruction text. Longest-first.
  const text = instruction.toLowerCase();
  const keys = Object.keys(CATEGORY_CODES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const re = new RegExp(`\\b${k.replace(/\s+/g, '\\s+')}\\b`);
    if (re.test(text)) return CATEGORY_CODES[k];
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
  // Use Playwright element screenshot of the visible grid container —
  // captures live state including cell-replacement after click. Old code
  // grabbed a static <img> URL that didn't update across rounds, so
  // every round NopeCha got the same image and returned the same answer
  // (cited .work/li-login-close-deadline.log 2026-05-06: 6 rounds of
  // [2,5,7] for 'cars' even though tiles 2/5/7 had been replaced after
  // round 1).
  let gridImgB64: string | null = null;
  try {
    const targetSel = 'div.rc-imageselect-payload, table.rc-imageselect-table-33, table.rc-imageselect-table-44, table.rc-imageselect-table';
    const handle = await bframe.$(targetSel);
    if (handle) {
      // Race the screenshot with a deadline — main thread can be busy.
      const shotP = handle.screenshot({ type: 'jpeg', quality: 90 });
      const deadline = new Promise<Buffer>((_, rej) => setTimeout(() => rej(new Error('screenshot_deadline')), 6000));
      const buf = await Promise.race([shotP, deadline]);
      gridImgB64 = buf.toString('base64');
    }
  } catch (e: any) { console.log(`[recaptcha] grid screenshot err: ${e?.message?.slice(0, 80)}`); }
  if (!gridImgB64) return null;
  // Save extracted grid for diagnostic comparison with displayed grid
  const diagDir = runRecordingsDir('vision'); // G17: recordings/<run_uuid>/vision/
  mkdirSync(diagDir, { recursive: true });
  writeFileSync(join(diagDir, 'extracted_grid_latest.png'), Buffer.from(gridImgB64, 'base64'));
  // Multi-solver consensus. Run NopeCha + CapSolver + 2captcha in parallel,
  // majority-vote per tile (tile selected iff ≥2 solvers picked it). 2026-05-06
  // run had NopeCha return [4,9] for fire-hydrant 3x3 while ground truth was
  // [1,7,9] — first-response-wins committed the wrong answer and burned the
  // session. Consensus catches single-solver miscounts before submit.
  const { getCaptchaCredentials: getCreds } = await import('../utils/credentials.js');
  const creds = await getCreds();
  const instr = instruction.replace(/\n/g, ' ').trim();

  async function nopechaSolve(): Promise<number[] | null> {
    const k = creds.nopecha ?? ''; if (!k) return null;
    try {
      const post = await (await fetch('https://api.nopecha.com/v1/recognition/recaptcha', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${k}` },
        body: JSON.stringify({ type: 'recaptcha', task: instr, image_data: [gridImgB64], grid: `${gridSize}x${gridSize}` }),
      })).json() as any;
      const jobId = post?.data; if (!jobId) return null;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000));  // allow-raw-playwright: polling/rate-limit loop
        const g = await (await fetch(`https://api.nopecha.com/v1/recognition/recaptcha?id=${jobId}`, { headers: { 'Authorization': `Basic ${k}` } })).json() as any;
        if (Array.isArray(g?.data)) return (g.data as boolean[]).map((v, i) => v ? i + 1 : 0).filter(Boolean);
        if (g?.error && g.error !== 14) return null;
      }
    } catch { /* fall through to null */ }
    return null;
  }
  async function capsolverSolve(): Promise<number[] | null> {
    const k = creds.capsolver ?? ''; const q = instructionToCode(instruction); if (!k || !q) return null;
    try {
      const d = await (await fetch('https://api.capsolver.com/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: k, task: { type: 'ReCaptchaV2Classification', image: gridImgB64, question: q } }) })).json() as any;
      return Array.isArray(d.solution?.objects) ? (d.solution.objects as number[]).map(i => i + 1) : null;
    } catch { return null; }
  }
  async function twocaptchaSolve(): Promise<number[] | null> {
    const k = creds.twocaptcha ?? ''; if (!k) return null;
    const c = await (await fetch('https://api.2captcha.com/createTask', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: k, task: { type: 'GridTask', body: gridImgB64, comment: instr, rows: gridSize, columns: gridSize } }),
    })).json() as any;
    if (!c.taskId) return null;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 3000));  // allow-raw-playwright: polling/rate-limit loop
      const r = await (await fetch('https://api.2captcha.com/getTaskResult', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: k, taskId: c.taskId }),
      })).json() as any;
      if (r.status === 'ready') return r.solution?.click ?? null;
      if (r.errorId) return null;
    }
    return null;
  }
  // Claude vision as a parallel 4th solver (not just tiebreaker). API solvers
  // agreed on cars 3x3 [5,6,8] in 2026-05-09 LinkedIn run but LinkedIn
  // rejected — both were systematically wrong. Adding Claude expands the
  // signal so a 3-of-4 majority can override a 2-solver mistake.
  async function claudeSolve(): Promise<number[] | null> {
    try {
      const v = await import('../vision/analyze.js') as any;
      const ask = v.askClaude as ((b: Buffer, q: string, t?: string) => string) | undefined;
      if (!ask) return null;
      const grid = gridSize === 3 ? '1 2 3 / 4 5 6 / 7 8 9' : '1-4/5-8/9-12/13-16';
      const b64 = gridImgB64 as string; // narrowed: line 72 returns null if falsy
      const ans = ask(Buffer.from(b64, 'base64'), `reCAPTCHA grid (${grid}). Instruction: "${instr}". Return ONLY a JSON array of positions, e.g. [1,4,7].`, 'tier_image');
      const mm = (ans || '').match(/\[[\d,\s]*\]/);
      if (!mm) return null;
      const p = JSON.parse(mm[0]);
      return Array.isArray(p) ? p as number[] : null;
    } catch { return null; }
  }
  const settled = await Promise.allSettled([nopechaSolve(), capsolverSolve(), twocaptchaSolve(), claudeSolve()]);
  const labels = ['NopeCha', 'CapSolver', '2captcha', 'Claude'];
  const answers: { name: string; positions: number[] }[] = [];
  settled.forEach((s, i) => {
    const pos = s.status === 'fulfilled' && Array.isArray(s.value) ? s.value as number[] : null;
    console.log(`[recaptcha] ${labels[i]}: ${pos ? JSON.stringify(pos) : 'null'}`);
    if (pos) answers.push({ name: labels[i], positions: pos });
  });
  if (answers.length === 0) return null;
  if (answers.length === 1) {
    // Claude tiebreaker — ask vision on the grid image, require 2-of-2.
    try {
      const v = await import('../vision/analyze.js') as any;
      const ask = v.askClaude as ((b: Buffer, q: string, t?: string) => string) | undefined;
      if (ask) {
        const grid = gridSize === 3 ? '1 2 3 / 4 5 6 / 7 8 9' : '1-4/5-8/9-12/13-16';
        const ans = ask(Buffer.from(gridImgB64, 'base64'), `reCAPTCHA grid (${grid}). Instruction: "${instr}". Return ONLY a JSON array of positions, e.g. [1,4,7].`, 'tier_image');
        const mm = (ans || '').match(/\[[\d,\s]*\]/);
        if (mm) { try { const cp = JSON.parse(mm[0]); if (Array.isArray(cp)) { console.log(`[recaptcha] Claude tiebreaker: ${JSON.stringify(cp)}`); answers.push({ name: 'Claude', positions: cp }); } } catch {} }
      }
    } catch {}
    if (answers.length === 1) { console.log(`[recaptcha] Only ${answers[0].name} responded`); return answers[0].positions; }
  }
  // Claude-first consensus. Verified 2026-05-09 on LinkedIn: NopeCha+2captcha
  // agreed on cars 3x3 [5,6,8] and bicycles 4x4 [9,10] — both rejected by
  // LinkedIn's grader. The two API solvers share the same flawed CNN backbone
  // for these challenge classes, so their "agreement" doesn't mean correct;
  // it means correlated wrong. Claude vision (multimodal LLM) is the
  // strongest signal we have. Strategy:
  //   1) If Claude returned an answer, submit Claude's answer (it picks tiles
  //      most reliably on LinkedIn-style challenges).
  //   2) Else fall back to ≥2-of-N majority of the API solvers.
  const claudeAns = answers.find(a => a.name === 'Claude');
  if (claudeAns && claudeAns.positions.length > 0) {
    console.log(`[recaptcha] Submitting Claude's answer: ${JSON.stringify(claudeAns.positions)} (API solvers: ${answers.filter(a => a.name !== 'Claude').map(a => `${a.name}=${JSON.stringify(a.positions)}`).join(', ')})`);
    return claudeAns.positions.slice().sort((a, b) => a - b);
  }
  const tally = new Map<number, number>();
  for (const a of answers) for (const p of new Set(a.positions)) tally.set(p, (tally.get(p) ?? 0) + 1);
  const majority = [...tally.entries()].filter(([, c]) => c >= 2).map(([p]) => p).sort((a, b) => a - b);
  console.log(`[recaptcha] No Claude answer; consensus (≥2 of ${answers.length}): ${JSON.stringify(majority)}`);
  const minT = gridSize === 3 ? 1 : 2;
  if (majority.length < minT) { const { disagreementTiebreaker } = await import('./consensus.js'); const t = await disagreementTiebreaker(answers, gridImgB64, instr, gridSize, minT); if (t && t.length > 0) return t; }
  return majority.length > 0 ? majority : answers[0].positions;
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
    // Claude vision secondary — uses shared askPage() from vision/analyze.ts
    if (!positions) {
      const grid = gridSize === 3 ? '1 2 3\n4 5 6\n7 8 9' : '1  2  3  4\n5  6  7  8\n9  10 11 12\n13 14 15 16';
      const prompt = `reCAPTCHA: "${instruction.replace(/\n/g,' ')}"\nGrid: ${grid}\nReturn ONLY JSON array of positions. Example: [1,4,7]`;
      const answer = await askPage(page as unknown as ScreenshottablePage, prompt, pageScreenshot).catch(() => '');
      positions = parsePositions(answer);
      if (positions) console.log(`[recaptcha] Claude: ${JSON.stringify(positions)}`);
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
