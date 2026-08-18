// weles gradio debugging path — one-shot Playwright inspector for the
// wisent-gradio app. Opens the app, clicks a tab, and captures the
// rendered state (screenshots + DOM summary) so the benchmark-debug
// views (contrastive pairs, activations, provenance) can be checked
// without a human at the browser.
//
// Usage:
//   node scripts/inspect/gradio.mjs [--url http://localhost:7860] [--tab "Benchmark Debug"]
//
// Writes to .work/inspect/gradio/: landing_<ts>.png, tab_<ts>.png,
// summary_<ts>.json. Target is our own Gradio app on localhost — there is
// no bot classifier, so raw Playwright is used directly (humanized atoms
// exist for evading anti-bot on external sites, irrelevant here). Waits
// are event-based (waitForLoadState), no fixed-duration timeouts.

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : def;
};
const URL = opt('--url', 'http://localhost:7860');
const TAB_LABEL = opt('--tab', 'Benchmark Debug');
const BENCH = opt('--benchmark', '');
const MODEL = opt('--model', '');
const DRIVE = argv.includes('--drive');
const MACRO_ONLY = argv.includes('--macro-only');
const OUT = '.work/inspect/gradio';
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 } });
try {
  // Gradio holds open ws/SSE connections, so 'networkidle' never settles;
  // wait on 'load' then on the tab nav rendering instead.
  await page.goto(URL, { waitUntil: 'load' }); // allow-raw-playwright: localhost own-app, no anti-bot
  await page.waitForSelector('button[role="tab"], .tab-nav, [role="tab"]', { state: 'visible' }); // allow-raw-playwright: localhost own-app

  await page.screenshot({ path: join(OUT, `landing_${ts}.png`), fullPage: true }); // allow-raw-playwright: localhost own-app

  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button[role="tab"], .tab-nav button, [role="tab"]'))
      .map((b) => b.innerText.trim())
      .filter(Boolean));

  let clicked = false;
  try {
    await page.getByRole('tab', { name: TAB_LABEL }).first().click(); // allow-raw-playwright: localhost own-app
    clicked = true;
    await page.waitForLoadState('load'); // allow-raw-playwright: localhost own-app
  } catch { /* tab not found by role; summary still captures landing state */ }

  await page.screenshot({ path: join(OUT, `tab_${ts}.png`), fullPage: true }); // allow-raw-playwright: localhost own-app

  if (DRIVE && MACRO_ONLY) {
    // Focused: load ONLY the Missing view so its render isn't queued behind
    // the coverage/sizes events — lets the boolean render-check actually pass.
    try {
      const clickBtn = (text) => page.evaluate((text) => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === text); if (!b) throw new Error(`no button '${text}'`); b.click(); }, text); // allow-raw-playwright: localhost own-app, page-ctx DOM
      let switched = false;
      for (let i = 0; i < 6 && !switched; i++) {
        try { await page.getByRole('tab', { name: 'Macro Check' }).click(); } catch (e) { await clickBtn('Macro Check'); } // allow-raw-playwright: localhost own-app
        try {
          await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Load missing')); // allow-raw-playwright: localhost own-app
          switched = true;
        } catch (e) { /* sub-tab content not rendered yet — retry */ }
      }
      console.log(`[macro-only] macro-check sub-tab switched=${switched}`);
      await clickBtn('Load coverage matrix'); // allow-raw-playwright: localhost own-app
      let covOk = false;
      for (let i = 0; i < 10 && !covOk; i++) {
        try {
          await page.waitForFunction(() => [...document.querySelectorAll('.prose,.md,[class*="markdown" i]')].some((e) => /activations=\d+/.test(e.innerText))); // allow-raw-playwright: localhost own-app
          covOk = true;
        } catch (e) { /* slow inventory load — retry */ }
      }
      console.log(`[macro-only] coverage summary (activations= label) loaded=${covOk}`);
      await clickBtn('Load benchmark sizes'); // allow-raw-playwright: localhost own-app
      let szOk = false;
      for (let i = 0; i < 10 && !szOk; i++) {
        try {
          await page.waitForFunction(() => [...document.querySelectorAll('.prose,.md,[class*="markdown" i]')].some((e) => /[Mm]ax original \d+/.test(e.innerText))); // allow-raw-playwright: localhost own-app
          szOk = true;
        } catch (e) { /* slow 1163-JSON read — retry */ }
      }
      console.log(`[macro-only] benchmark sizes loaded=${szOk}`);
      await clickBtn('Load missing'); // allow-raw-playwright: localhost own-app
      let mOk = false;
      for (let i = 0; i < 8 && !mOk; i++) {
        try {
          await page.waitForFunction(() => [...document.querySelectorAll('.prose,.md,[class*="markdown" i]')].some((e) => /raw_activations missing: \d+ cells/.test(e.innerText))); // allow-raw-playwright: localhost own-app
          mOk = true;
        } catch (e) { /* slow load — retry */ }
      }
      console.log(`[macro-only] missing boolean=${mOk}`);
      writeFileSync(join(OUT, `macroonly_${ts}.txt`), await page.evaluate(() => [...document.querySelectorAll('.prose,.md,[class*="markdown" i]')].map((e) => e.innerText).filter((t) => t.includes('Coverage:') || t.includes('Benchmark sizes') || t.includes('Missing by store') || t.includes('Missing from ALL')).join('\n---\n').slice(0, 5000))); // allow-raw-playwright: localhost own-app
      await page.screenshot({ path: join(OUT, `macroonly_${ts}.png`), fullPage: true }); // allow-raw-playwright: localhost own-app
    } catch (e) { console.error(`[macro-only] failed: ${e.message}`); }
  } else if (DRIVE && BENCH && MODEL) {
    try {
      // Headless pointer events on Gradio's role="listbox" dropdown inputs
      // never settle — click/fill/force-click all hang at "performing click
      // action" until timeout. Drive the Svelte components via DOM events in
      // page context instead (native value setter + dispatched input/Enter,
      // native button click). isTrusted=false is irrelevant: our own localhost
      // app, no bot classifier. allow_custom_value=True => Enter commits value.
      const setDropdown = (label, value) => page.evaluate(({ label, value }) => { // allow-raw-playwright: localhost own-app, page-ctx DOM
        const el = [...document.querySelectorAll('input[aria-label]')].filter((i) => i.getAttribute('aria-label') === label).pop();
        if (!el) throw new Error(`no dropdown input labelled ${label}`);
        el.focus(); // allow-raw-playwright: localhost own-app, page ctx
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true })); // allow-raw-playwright: localhost own-app, page ctx
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); // allow-raw-playwright: localhost own-app, page ctx
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true })); // allow-raw-playwright: localhost own-app, page ctx
        el.dispatchEvent(new Event('change', { bubbles: true })); // allow-raw-playwright: localhost own-app, page ctx
        el.blur(); // allow-raw-playwright: localhost own-app, page ctx
      }, { label, value }); // allow-raw-playwright: localhost own-app, page-ctx DOM
      const clickButton = (text) => page.evaluate((text) => { // allow-raw-playwright: localhost own-app, page-ctx DOM
        const btn = [...document.querySelectorAll('button')].find((b) => b.innerText.trim() === text);
        if (!btn) throw new Error(`no button '${text}'`);
        btn.click(); // allow-raw-playwright: localhost own-app, page ctx
      }, text); // allow-raw-playwright: localhost own-app, page-ctx DOM

      await setDropdown('Benchmark', BENCH);
      await page.waitForLoadState('load'); // allow-raw-playwright: localhost own-app
      await setDropdown('Model', MODEL); // model change auto-selects first Layer
      await page.waitForLoadState('load'); // allow-raw-playwright: localhost own-app

      await clickButton('Show Pairs by Format');
      try {
        await page.waitForFunction(() => !document.body.innerText.includes('Select Benchmark + Model above, then click')); // allow-raw-playwright: localhost own-app
      } catch (e) { console.error(`[formats wait — capturing anyway] ${e.message}`); }
      await page.screenshot({ path: join(OUT, `formats_${ts}.png`), fullPage: true }); // allow-raw-playwright: localhost own-app

      // Gradio's allow_custom_value Model dropdown can revert to its last
      // discovered choice after the prior button's output re-render, so
      // re-assert the model right before reading activations.
      await setDropdown('Model', MODEL);
      await clickButton('Inspect Activations');
      try {
        await page.waitForFunction(() => !document.body.innerText.includes('Select Benchmark + Model + Layer above, then click')); // allow-raw-playwright: localhost own-app
      } catch (e) { console.error(`[activations wait — capturing anyway] ${e.message}`); }
      await page.screenshot({ path: join(OUT, `activations_${ts}.png`), fullPage: true }); // allow-raw-playwright: localhost own-app

      await clickButton('Show Token-by-Token');
      try {
        await page.waitForFunction(() => !document.body.innerText.includes('Pick prompt format + pair id, then click.')); // allow-raw-playwright: localhost own-app
      } catch (e) { console.error(`[tokens wait — capturing anyway] ${e.message}`); }
      await page.screenshot({ path: join(OUT, `tokens_${ts}.png`), fullPage: true }); // allow-raw-playwright: localhost own-app

      await clickButton('Show All 7 Strategies (aggregations)');
      try {
        await page.waitForFunction(() => !document.body.innerText.includes('Per-pair vectors under all 7 strategies (norms).')); // allow-raw-playwright: localhost own-app
      } catch (e) { console.error(`[strategies wait — capturing anyway] ${e.message}`); }
      await page.screenshot({ path: join(OUT, `strategies_${ts}.png`), fullPage: true }); // allow-raw-playwright: localhost own-app

      // Inventory: exercise the legacy-aggregated path via a known legacy combo
      await clickButton('Load inventory');
      await setDropdown('All activations', '[legacy] meta-llama__Llama-3.2-1B-Instruct/aclue');
      await clickButton('Inspect Selected');
      try {
        await page.waitForFunction(() => !document.body.innerText.includes('Load inventory, pick an entry (uses Layer above), then Inspect Selected.')); // allow-raw-playwright: localhost own-app
      } catch (e) { console.error(`[inventory wait — capturing anyway] ${e.message}`); }
      await page.screenshot({ path: join(OUT, `inventory_${ts}.png`), fullPage: true }); // allow-raw-playwright: localhost own-app

      // Macro Check sub-tab: native DOM click doesn't switch Gradio sub-tabs
      // on the deployed Space — use the tab role + retry until its Load
      // buttons render, like the macro-only branch.
      let mtab = false;
      for (let i = 0; i < 6 && !mtab; i++) {
        try { await page.getByRole('tab', { name: 'Macro Check' }).click(); } catch (e) { await clickButton('Macro Check'); } // allow-raw-playwright: localhost own-app
        try { await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.innerText.trim() === 'Load coverage matrix')); mtab = true; } catch (e) { /* retry */ } // allow-raw-playwright: localhost own-app
      }
      console.log(`[macro] sub-tab switched=${mtab}`);
      await clickButton('Load coverage matrix');
      // Full-inventory enumeration is slow; retry the default-timeout wait a
      // few times (no fixed timeout literal) until the coverage summary lands.
      let macroOk = false;
      for (let i = 0; i < 4 && !macroOk; i++) {
        try {
          await page.waitForFunction(() => /Coverage:\s+\d+\s+benchmarks/.test(document.body.innerText)); // allow-raw-playwright: localhost own-app
          macroOk = true;
        } catch (e) { /* slow load — retry */ }
      }
      await clickButton('Load benchmark sizes');
      let szOk = false;
      for (let i = 0; i < 4 && !szOk; i++) {
        try {
          await page.waitForFunction(() => /[Mm]ax original = \d+/.test(document.body.innerText)); // allow-raw-playwright: localhost own-app
          szOk = true;
        } catch (e) { /* slow load — retry */ }
      }
      await clickButton('Load missing');
      let missOk = false;
      for (let i = 0; i < 4 && !missOk; i++) {
        try {
          await page.waitForFunction(() => /Missing from ALL models: \d+/.test(document.body.innerText)); // allow-raw-playwright: localhost own-app
          missOk = true;
        } catch (e) { /* slow load — retry */ }
      }
      if (!macroOk || !szOk || !missOk) console.error(`[macro] coverage=${macroOk} sizes=${szOk} missing=${missOk}`);
      writeFileSync(join(OUT, `macro_${ts}.txt`), await page.evaluate(() => [...document.querySelectorAll('.prose,.md,[class*="markdown" i]')].map((e) => e.innerText).filter((t) => t.includes('Coverage:') || t.includes('Benchmark sizes') || t.includes('Missing')).join('\n---\n').slice(0, 6000))); // allow-raw-playwright: localhost own-app
      await page.screenshot({ path: join(OUT, `macro_${ts}.png`), fullPage: true }); // allow-raw-playwright: localhost own-app

      writeFileSync(join(OUT, `drive_${ts}.txt`), await page.evaluate(() => document.body.innerText.slice(0, 80000)));
      console.log(`[gradio-inspect] drive: wrote formats_${ts}.png activations_${ts}.png drive_${ts}.txt`);
    } catch (e) {
      console.error(`[gradio-inspect] drive failed: ${e.message}`);
    }
  }

  const summary = await page.evaluate(() => {
    const text = document.body.innerText.slice(0, 12000);
    const md = Array.from(document.querySelectorAll('.prose, .md, [class*="markdown" i]'))
      .map((e) => e.innerText.trim())
      .filter(Boolean)
      .slice(0, 12);
    const controls = Array.from(document.querySelectorAll('select, [role="listbox"], input[role="combobox"]'))
      .map((e) => {
        const lbl = e.getAttribute('aria-label');
        return {
          tag: e.tagName,
          label: lbl ? lbl.slice(0, 60) : '',
          value: e.value ? String(e.value).slice(0, 60) : '',
        };
      });
    return { url: location.href, title: document.title, bodyTextHead: text, markdownPanels: md, controls };
  });

  writeFileSync(join(OUT, `summary_${ts}.json`),
    JSON.stringify({ tabs, requestedTab: TAB_LABEL, clicked, ...summary }, null, 2));
  console.log(`[gradio-inspect] tabs=${JSON.stringify(tabs)} clicked=${clicked}`);
  console.log(`[gradio-inspect] wrote landing_${ts}.png tab_${ts}.png summary_${ts}.json -> ${OUT}`);
} catch (e) {
  console.error(`[gradio-inspect] FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
