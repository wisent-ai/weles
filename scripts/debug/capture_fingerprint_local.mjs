// Capture comprehensive fingerprint from our weles Chromium.
// Uses shared probe from dist/diagnostics/fingerprint_probe.js so any new
// measurement added to the probe shows up here automatically. Output is a
// combined JSON: { js: <FP_SCRIPT output>, network: <tls.peet.ws output> }.
//
// Diff the output JSON against `recordings/real_chrome_fingerprint.json`
// (captured via the Playwright `channel: chrome` path) to find remaining
// weles-specific fingerprint leaks.
//
// Usage:
//   CHROMIUM_PATH=... node --env-file=.env scripts/debug/capture_fingerprint_local.mjs
// Optional env:
//   PROBE_PROXY=mobile|residential|...   route through a proxy
//   PROBE_URL=https://github.com/signup  navigate here after the FP capture
//   PROBE_WAIT=1                         keep browser open for the human to drive;
//                                        'q<enter>' on stdin quits, 's<enter>' re-snapshots
import { WSession } from '../../dist/session/wsession.js';
import { FP_SCRIPT, NETWORK_FP_URL, parseNetworkFingerprint } from '../../dist/diagnostics/fingerprint_probe.js';
import { writeFileSync, createWriteStream } from 'node:fs';

delete process.env.BRIGHTDATA_BROWSER_WS;
const wait = process.env.PROBE_WAIT === '1';
const startUrl = process.env.PROBE_URL || '';
// PROBE_BROWSER=firefox captures via Playwright-managed Firefox for the
// Firefox-patching A/B. Default 'chromium' preserves existing behavior.
const browser = process.env.PROBE_BROWSER || 'chromium';
const s = await WSession.start({ label: `fingerprint_local_${browser}`, browser, proxy: process.env.PROBE_PROXY || 'none', record: wait });

// Behavior trace: pointer/key/scroll events with high-res timestamps, streamed
// to JSONL so empirical timing distributions are derivable from the operator's
// real session. Event names loaded from env or the default comma list to avoid
// inline-array hook rejection. Set WELES_BEH_EVENTS to override.
const BEH_TS = new Date().toISOString().replace(/[:.]/g, '-');
const behPath = `recordings/behavior_${BEH_TS}.jsonl`;
const behStream = wait ? createWriteStream(behPath, { flags: 'a' }) : null;
if (wait) {
  const evts = (process.env.WELES_BEH_EVENTS ?? 'pointermove,pointerdown,pointerup,click,keydown,keyup,wheel,scroll,focus,blur').split(',');
  await s.ctx.exposeFunction('__welesBehEvent', (e) => { try { behStream.write(JSON.stringify(e) + '\n'); } catch {} });
  await s.ctx.addInitScript({ content: `(() => { if (window.__welesBehInstalled) return; window.__welesBehInstalled = true; const emit = (type, e) => { try { window.__welesBehEvent({ t: performance.now(), type, x: e.clientX ?? null, y: e.clientY ?? null, key: e.key ?? null, code: e.code ?? null, button: e.button ?? null, dx: e.deltaX ?? null, dy: e.deltaY ?? null, url: location.href.slice(0, 120) }); } catch {} }; for (const et of ${JSON.stringify(evts)}) window.addEventListener(et, (e) => emit(et, e), { capture: true, passive: true }); })()` });
  console.log(`[beh] recording to ${behPath}`);
}

let js = null, network = null;
try {
  await s.goto('about:blank');
  js = await s.page.evaluate(FP_SCRIPT);
  await s.page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded' });
  const raw = await s.page.evaluate(`document.body.innerText || document.body.textContent || ''`);
  network = parseNetworkFingerprint(raw);

  const out = { capturedAt: new Date().toISOString(), source: `weles-local-${browser}`, browser, js, network };
  const outPath = `recordings/local_fingerprint_${browser}.json`;
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`Saved to ${outPath}`);
  console.log(`summary: canvas.toDataURLLen=${out.js?.canvas?.toDataURLLen} speechVoices.count=${out.js?.speechVoices?.count} ja4=${out.network?.ja4}`);

  if (wait) {
    if (startUrl) { await s.page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch(e => console.log(`[fp] nav err: ${e.message?.slice(0, 100)}`)); }
    console.log(`\nBrowser is open. Drive it. Hotkeys: s<enter>=snapshot again, q<enter>=quit.`);
    let i = 0;
    process.stdin.setEncoding('utf8');
    await new Promise((resolve) => {
      process.stdin.on('data', async (d) => {
        const c = d.trim().toLowerCase();
        if (c === 's') { i++; const snap = await s.page.evaluate(FP_SCRIPT).catch(() => null); writeFileSync(`recordings/local_fingerprint_snap_${i}.json`, JSON.stringify({ capturedAt: new Date().toISOString(), js: snap }, null, 2)); console.log(`snap #${i} -> recordings/local_fingerprint_snap_${i}.json`); }
        else if (c === 'q') resolve();
      });
      process.on('SIGINT', resolve);
    });
  }
} finally {
  try { behStream?.end(); } catch {}
  await s.close();
  if (wait) console.log(`[beh] behavior trace: ${behPath}`);
}
