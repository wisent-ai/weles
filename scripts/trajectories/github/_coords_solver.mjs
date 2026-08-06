// Arkose FunCaptcha rotation puzzle solver.
// Tier 1: authenticated Stado multimodal model routing for a single-call
// coordinate pick. Tier 2: explicitly enabled 2captcha human workers.
// Both strategies consume the same iframe screenshot and emit a pixel center.

const POLL_SECONDS = 300;

import { writeFileSync, mkdirSync } from 'node:fs';
import { humanClick, humanIdlePause } from '../../../dist/human/mouse.js';
import { completeMultimodal, requireStadoModelRouterConfig } from './_stado_model_router.mjs';

async function waitForCaptchaUI(page) {
  // Force-strip `v-hidden`/`d-none` classes and inline visibility so puzzle iframe becomes visible.
  // GitHub's JS normally removes these after solver-ready event, but our automation flow doesn't trigger that.
  await page.evaluate(`(() => {
    const f = document.querySelector('iframe.js-octocaptcha-frame');
    if (!f) return { ok: false, reason: 'no-iframe' };
    f.classList.remove('v-hidden', 'd-none');
    f.style.visibility = 'visible';
    f.style.display = 'block';
    f.style.opacity = '1';
    // Also unhide parent containers
    let el = f.parentElement;
    for (let i = 0; i < 5 && el; i++) {
      el.classList.remove('v-hidden', 'd-none', 'js-octocaptcha-hide');
      el.removeAttribute('hidden');
      el = el.parentElement;
    }
    return { ok: true };
  })()`).catch(() => {});
  for (let i = 0; i < 90; i++) {
    const iframe = page.locator('iframe.js-octocaptcha-frame').first();
    const box = await iframe.boundingBox().catch(() => null);
    if (box && box.height > 200 && box.width > 200) {
      try {
        const buf = await page.screenshot({ type: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height } });
        if (i === 10 || i === 30) {
          try {
            mkdirSync('/tmp/gh_shots', { recursive: true });
            writeFileSync(`/tmp/gh_shots/captcha_t${i}.png`, buf);
            const fullBuf = await page.screenshot({ type: 'png', fullPage: false });
            writeFileSync(`/tmp/gh_shots/full_t${i}.png`, fullBuf);
            console.log(`[coords] Saved /tmp/gh_shots/captcha_t${i}.png (${Math.round(buf.length / 1024)}KB) + full_t${i}.png (${Math.round(fullBuf.length / 1024)}KB)`);
          } catch {}
        }
        if (buf.length > 15000) {
          console.log(`[coords] Puzzle UI ready at ${i}s: ${Math.round(box.width)}x${Math.round(box.height)}, ${Math.round(buf.length / 1024)}KB`);
          return { iframe, box };
        }
        if (i % 5 === 0) console.log(`[coords] Wait ${i}s box=${Math.round(box.width)}x${Math.round(box.height)} page-clip=${Math.round(buf.length / 1024)}KB`);
      } catch (e) { if (i % 5 === 0) console.log(`[coords] Wait ${i}s screenshot err: ${e.message?.slice(0, 80)}`); }
    }
    await humanIdlePause('short');
  }
  return null;
}

async function solveViaStadoModelRouter(imageBase64, width, height) {
  const prompt = `You are solving an Arkose FunCaptcha. Screenshot ${width}x${height} px.

TRIAGE FIRST (stop at first match):
1. "Reload Challenge"/"Try again"/"Retry" button OR text "That was not quite right"/"That was not quite fast enough" visible → G. Return (x,y) of button center (or page center if no button rendered yet).
2. "Audio Challenge" heading with Play + text input → D.
3. "Verify your account" with "Visual puzzle"/"Audio puzzle" buttons → A.
4. Otherwise classify puzzle (B, E, F, or C).

Screen types:
A) CHOOSER: two stacked buttons. Action: visual.
B) TILE_GRID: instruction + grid of image tiles where ONE matches. Return tile center as (x,y). Action: tile.
D) AUDIO_CHALLENGE: Action: back_to_visual.
E) BASKET_MATCH / PIPELINE / WIRE-MATCH: any puzzle with reference LEFT vs candidate RIGHT plus ← → arrows + Submit. Return "score":<0-10> rating how well the candidate matches the reference (10=perfect, 0=nothing matches). Set action=next unless you're highly confident (score>=9); caller decides when to submit. If right panel is a loading spinner or blank, action=none and score=0.
F) ORIENTATION_GRID: grid of rotated tiles. Return center of correct tile. Action: tile.
G) TRY_AGAIN: red error banner at top. Action: try_again. Return (x,y) for the "Try again" button center.
C) OTHER: loading spinner, success, blank. Action: none.

Be conservative: if the right panel is a loading spinner or placeholder, action=none — never submit on a loading screen. If ANY red error banner is visible, classify as G regardless of images below it.

Emit ONLY the JSON on a single line — no prose, no markdown, no explanation before or after. Keep "why" to 6 words max. "score" only matters for screen E.
{"screen":"A"|"B"|"C"|"D"|"E"|"F"|"G","action":"visual"|"tile"|"back_to_visual"|"next"|"submit"|"try_again"|"none","x":<int>,"y":<int>,"score":<0-10>,"why":"<6 words>"}`;
  try {
    const { text, model } = await completeMultimodal({
      base64: imageBase64,
      mimeType: 'image/png',
      prompt,
      maxTokens: Number('2048'),
    });
    const sMatch = text.match(/"screen"\s*:\s*"([ABCDEFG])"/);
    const aMatch = text.match(/"action"\s*:\s*"([a-z_]+)"/);
    const xMatch = text.match(/"x"\s*:\s*(-?\d+)/);
    const yMatch = text.match(/"y"\s*:\s*(-?\d+)/);
    if (!sMatch) {
      console.log(`[stado-model] no-screen text="${text.slice(Number(false), Number('200')).replace(/\n/g, ' ')}"`);
      return { err: 'no-screen completion' };
    }
    const screen = sMatch.at(Number(true));
    const action = aMatch?.at(Number(true)) ?? 'none';
    let x = Number(xMatch?.at(Number(true)) ?? '0');
    let y = Number(yMatch?.at(Number(true)) ?? '0');
    if (x >= width * Number('2') || y >= height * Number('2')) {
      x = Math.round(x * width / Number('1000'));
      y = Math.round(y * height / Number('1000'));
    }
    x = Math.max(Number(false), Math.min(width - Number(true), x));
    y = Math.max(Number(false), Math.min(height - Number(true), y));
    const score = Number(text.match(/"score"\s*:\s*(\d+)/)?.at(Number(true)) ?? '0');
    const why = (text.match(/"why"\s*:\s*"([^"]*)"/)?.at(Number(true)) ?? '').slice(Number(false), Number('80'));
    console.log(`[stado-model] screen=${screen} action=${action} score=${score} model=${model} coords(${x},${y}) — ${why}`);
    return { x, y, screen, action, score };
  } catch (error) {
    return { err: `router: ${String(error?.message || error).slice(Number(false), Number('120'))}` };
  }
}

async function submitCoords(apiKey, imageBase64, comment) {
  const task = { type: 'CoordinatesTask', body: imageBase64, comment };
  const cr = await (await fetch('https://api.2captcha.com/createTask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, task }),
  })).json();
  if (cr.errorId) return { err: `${cr.errorCode} ${cr.errorDescription?.slice(0, 120)}` };
  console.log(`[coords] taskId=${cr.taskId}`);
  for (let i = 0; i < POLL_SECONDS / 5; i++) {
    await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
    const res = await (await fetch('https://api.2captcha.com/getTaskResult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId: cr.taskId }),
    })).json();
    if (res.status === 'ready') return { coords: res.solution?.coordinates ?? [] };
    if (res.errorId) return { err: `${res.errorCode} ${res.errorDescription?.slice(0, 100)}` };
    if (i % 6 === 0 && i > 0) console.log(`[coords] solving ${i * 5}s`);
  }
  return { err: 'polling exceeded' };
}

function getEnforcementFrame(page) {
  return page.frames().find(f => /arkoselabs\.com.*enforcement.*\.html/.test(f.url()));
}

// Shadow-DOM + nested same-origin iframe button search. Arkose wraps in shadow
// roots AND in a game_core iframe; walks both. Returns coords only — caller
// must humanClick, since match.click() inside evaluate emits isTrusted=false.
const SHADOW_BTN_QUERY = `(needle => {
  const out = [];
  const walk = (root) => {
    if (!root?.querySelectorAll) return;
    const cands = root.querySelectorAll('button, [role="button"], a, [aria-label], [data-test], [data-testid]');
    for (const n of cands) out.push(n);
    for (const n of root.querySelectorAll('*')) {
      if (n.shadowRoot) walk(n.shadowRoot);
      if (n.contentDocument) walk(n.contentDocument);
    }
  };
  walk(document);
  const sig = (b) => {
    const vis = b.offsetParent !== null || (b.getClientRects && b.getClientRects().length);
    return {
      n: b.nodeName.toLowerCase(),
      cls: (b.className?.baseVal ?? b.className ?? '').toString().slice(0, 60),
      txt: (b.innerText || b.textContent || '').trim().slice(0, 40),
      aria: (b.getAttribute?.('aria-label') ?? '').slice(0, 40),
      title: (b.getAttribute?.('title') ?? '').slice(0, 40),
      dt: (b.getAttribute?.('data-test') ?? b.getAttribute?.('data-testid') ?? '').slice(0, 40),
      vis: !!vis,
    };
  };
  const haystack = (b) => {
    const s = sig(b);
    return (s.txt + ' ' + s.aria + ' ' + s.title + ' ' + s.dt + ' ' + s.cls).toLowerCase();
  };
  const match = out.find(b => haystack(b).includes(needle) && (b.offsetParent !== null || (b.getClientRects && b.getClientRects().length)));
  if (!match) return { ok: false, count: out.length, texts: out.slice(0, 12).map(sig) };
  match.scrollIntoView?.({ block: 'center' });
  const r = match.getBoundingClientRect();
  return { ok: true, sig: sig(match), x: r.x + r.width / 2, y: r.y + r.height / 2 };
})`;

async function clickInEnforcement(page, needles) {
  const frame = getEnforcementFrame(page);
  if (!frame) return { ok: false, reason: 'no-frame' };
  // Accept either a single string or a prioritized array of substrings.
  const arr = Array.isArray(needles) ? needles : [needles];
  for (const n of arr) {
    const r = await frame.evaluate(`${SHADOW_BTN_QUERY}(${JSON.stringify(n.toLowerCase())})`).catch(e => ({ err: e.message?.slice(0, 80) }));
    if (r?.ok) return r;
  }
  // Return info from last attempt so caller can log button inventory.
  return await frame.evaluate(`${SHADOW_BTN_QUERY}(${JSON.stringify(arr[arr.length - 1].toLowerCase())})`).catch(e => ({ err: e.message?.slice(0, 80) }));
}

async function clickVisualPuzzleInEnforcement(page) {
  // Arkose labels this button as "Visual challenge" in some renders and "Visual puzzle"
  // in others — match either substring.
  for (let i = 0; i < 20; i++) {
    const r = await clickInEnforcement(page, ['visual puzzle', 'visual challenge', 'visual']);
    if (r?.ok) { console.log(`[coords] clicked Visual puzzle in enforcement: "${r.text}" at (${Math.round(r.x)},${Math.round(r.y)})`); return true; }
    if (i % 3 === 0) console.log(`[coords] waiting Visual puzzle button (count=${r?.count ?? '?'} sample=${JSON.stringify(r?.texts ?? []).slice(0, 120)})`);
    await new Promise(r => setTimeout(r, 1000));  // allow-raw-playwright: polling/rate-limit loop
  }
  return false;
}

export async function solveRotationViaCoords(page, { maxRounds = 80 } = {}) {
  const twoKey = process.env.TWOCAPTCHA_API_KEY;
  requireStadoModelRouterConfig();
  // Step 0: click "Visual puzzle" button inside the enforcement iframe to dismiss the
  // puzzle-type chooser screen. Without this, every screenshot is the chooser.
  await clickVisualPuzzleInEnforcement(page);
  const waited = await waitForCaptchaUI(page);
  if (!waited) { console.log('[coords] captcha iframe never rendered'); return false; }

  let navCount = 0, bestScore = 0, totalSubmits = 0; // per-puzzle + session state
  const SUBMIT_BUDGET = parseInt(process.env.WELES_ARKOSE_SUBMIT_BUDGET ?? '4', 10);
  for (let round = 1; round <= maxRounds; round++) {
    const urlNow = page.url?.() ?? '';
    if (/signup_emailsent|verif|launch-code|account_verif/.test(urlNow)) { console.log(`[coords] R${round}: URL solved at ${urlNow}`); return true; }
    const box = await page.locator('iframe.js-octocaptcha-frame').first().boundingBox().catch(() => null);
    if (!box) { for (let i = 0; i < 15; i++) { await new Promise(r => setTimeout(r, 1000)); const u = page.url?.() ?? ''; if (/signup_emailsent|verif|launch-code|account_verif/.test(u)) { console.log(`[coords] R${round}: iframe gone, URL advanced to ${u}`); return true; } } console.log(`[coords] R${round}: iframe gone, URL stuck at ${page.url?.() ?? ''}`); return false; }  // allow-raw-playwright: polling/rate-limit loop
    let buf;
    try { buf = await page.screenshot({ type: 'png', clip: { x: box.x, y: box.y, width: box.width, height: box.height } }); }
    catch (e) { console.log(`[coords] R${round}: screenshot err: ${e.message?.slice(0, 120)}`); return false; }
    const b64 = buf.toString('base64');
    try { mkdirSync('/tmp/gh_shots', { recursive: true }); writeFileSync(`/tmp/gh_shots/round_${round}.png`, buf); } catch {}
    console.log(`[coords] R${round}: ${Math.round(buf.length / 1024)}KB image (${Math.round(box.width)}x${Math.round(box.height)}) -> /tmp/gh_shots/round_${round}.png`);
    let clickXY = null;
    // Tier 1: Stado's authenticated model router classifies the screen.
    {
      const g = await solveViaStadoModelRouter(b64, Math.round(box.width), Math.round(box.height));
      const w = Math.round(box.width), h = Math.round(box.height);
      if (g.screen === 'A') clickXY = { x: Math.round(w / 2), y: Number('262'), src: 'stado-model-A' };
      else if (g.screen === 'D') clickXY = { x: Number('120'), y: Number('418'), src: 'stado-model-D' };
      else if (g.screen === 'E') {
        if (g.action === 'none') { console.log(`[coords] R${round} E-none — waiting for puzzle to load`); await new Promise(r => setTimeout(r, 3000)); continue; }  // allow-raw-playwright: review — context-dependent timer
        if (navCount > 20) { console.log(`IP_FLAGGED: Arkose nav=${navCount} on single puzzle without match — carousel exhausted, rotate`); process.exit(42); }
        bestScore = Math.max(bestScore, g.score || 0);
        const threshold = Math.max(7, 9 - Math.floor(navCount / 4));
        const submitNow = g.action === 'submit' || (g.score >= threshold && g.score >= bestScore);
        const needles = submitNow ? ['submit'] : ['navigate to next', 'next', 'arrow'];
        const domResult = await clickInEnforcement(page, needles);
        if (domResult?.ok) { await humanClick(page, Math.round(box.x + domResult.x), Math.round(box.y + domResult.y)); console.log(`[coords] R${round} E-${submitNow?'submit':'next'} (score=${g.score} thresh=${threshold} nav=${navCount} submits=${totalSubmits}) humanClick: ${domResult.sig?.txt || domResult.sig?.aria}`); if (submitNow) { totalSubmits++; navCount = 0; bestScore = 0; if (totalSubmits > SUBMIT_BUDGET) { console.log(`IP_FLAGGED: Arkose served ${totalSubmits} puzzles without URL advance — treat as flagged, rotate proxy`); process.exit(42); } } else navCount++; await new Promise(r => setTimeout(r, 1500)); const u = page.url?.() ?? ''; if (/signup_emailsent|verif|launch-code|account_verif/.test(u)) return true; continue; }  // allow-raw-playwright: review — context-dependent timer
        const ex = g.x || (submitNow ? 226 : 370); const ey = g.y || (submitNow ? 340 : 300);
        clickXY = submitNow ? { x: ex, y: ey, src: 'stado-model-E-submit-coord' } : { x: ex, y: ey, src: 'stado-model-E-next-swipe', swipe: -100 };
      }
      else if (g.screen === 'G') {
        // Any non-E screen ends the current puzzle — reset nav state so the next
        // puzzle starts at max threshold instead of inheriting a low one.
        navCount = 0; bestScore = 0;
        const r = await clickInEnforcement(page, ['try again', 'reload', 'restart']);
        if (r?.ok) { await humanClick(page, Math.round(box.x + r.x), Math.round(box.y + r.y)); console.log(`[coords] R${round} G recover humanClick: ${JSON.stringify(r.sig ?? r.text)}`); await new Promise(r2 => setTimeout(r2, 4000)); continue; }  // allow-raw-playwright: review — context-dependent timer
        clickXY = { x: g.x || Math.round(w / 2), y: g.y || 340, src: 'stado-model-G-try-coord' };
      }
      else if ((g.screen === 'B' || g.screen === 'F') && g.action !== 'none' && g.x) { navCount = 0; bestScore = 0; clickXY = { x: g.x, y: g.y, src: `stado-model-${g.screen}` }; }
      else if ((g.screen === 'B' || g.screen === 'F' || g.screen === 'C') && g.action === 'none') { navCount = 0; bestScore = 0; console.log(`[coords] R${round} ${g.screen}-none — waiting for UI`); await new Promise(r => setTimeout(r, 3000)); continue; }  // allow-raw-playwright: review — context-dependent timer
      else console.log(`[coords] R${round} Stado model-router screen=${g.screen ?? '?'} err=${g.err ?? '-'}, falling back`);
      if (clickXY) console.log(`[coords] R${round} ${clickXY.src}: (${clickXY.x},${clickXY.y})`);
    }
    // The 2captcha path remains explicit opt-in. It is attempted only when the
    // authenticated model router cannot produce coordinates and the operator
    // has enabled the human-worker service.
    if (!clickXY && twoKey && process.env.WELES_2CAPTCHA_COORDS === '1') {
      const res = await submitCoords(twoKey, b64, `Arkose FunCaptcha. Return (x,y) of the correct tile center.`);
      if (res.coords?.length) { clickXY = { x: res.coords[0].x, y: res.coords[0].y, src: '2captcha' }; console.log(`[coords] R${round} 2captcha: (${res.coords[0].x},${res.coords[0].y})`); }
      else console.log(`[coords] R${round} 2captcha: ${res.err}`);
    }
    if (!clickXY) { console.log(`[coords] R${round}: no coords from any solver`); continue; }
    const pageX = box.x + clickXY.x, pageY = box.y + clickXY.y;
    // Hover first then split mousedown/up — Arkose ignores instant clicks.
    // When swipe is set, drag horizontally by that delta through 5 micro-moves
    // so the canvas sees a real pointer trajectory (mobile-first carousel).
    try {
      await page.mouse.move(pageX - 5, pageY - 3);
      await humanIdlePause('short');
      await page.mouse.move(pageX, pageY);
      await humanIdlePause('short');
      await page.mouse.down();
      await humanIdlePause('short');
      if (clickXY.swipe) {
        const steps = 6, dx = clickXY.swipe;
        for (let i = 1; i <= steps; i++) {
          await page.mouse.move(pageX + Math.round(dx * i / steps), pageY + (i % 2 === 0 ? 1 : -1));
          await humanIdlePause('short');
        }
        await humanIdlePause('short');
      }
      await page.mouse.up();
    } catch (e) { console.log(`[coords] pointer err: ${e.message?.slice(0, 100)}`); }
    const gesture = clickXY.swipe ? `swipe(${clickXY.swipe}px)` : 'clicked';
    console.log(`[coords] R${round} ${clickXY.src} ${gesture} page(${Math.round(pageX)},${Math.round(pageY)})`);
    await humanIdlePause('long');
    const u = page.url?.() ?? '';
    if (/signup_emailsent|verif|launch-code|account_verif/.test(u)) { console.log(`[coords] URL advanced to ${u}`); return true; }
  }
  return false;
}
