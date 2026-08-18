#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../dist/session/wsession.js';

const OUT_DIR = 'recordings/audits';
const LABEL = 'action_event_probe';

const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Weles event probe</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 40px; }
    label, input, select, button { display: block; margin: 14px 0; font-size: 18px; }
    input, select { width: 320px; padding: 8px; }
    button { padding: 10px 18px; }
  </style>
</head>
<body>
  <label>Email <input name="email" placeholder="email address" autocomplete="email"></label>
  <label>Country <select name="country"><option>Choose</option><option>United States</option><option>Poland</option></select></label>
  <button id="join">Agree & Join</button>
  <script>
    window.__events = [];
    const interesting = new Set(['email', 'country', 'join']);
    function targetName(t) {
      if (!t) return '';
      return t.id || t.name || t.getAttribute?.('placeholder') || t.tagName;
    }
    for (const type of ['pointerover','pointermove','pointerdown','mousedown','focus','keydown','beforeinput','input','keyup','change','pointerup','mouseup','click','blur']) {
      window.addEventListener(type, (e) => {
        const name = targetName(e.target);
        if (!interesting.has(name) && name !== 'email address') return;
        window.__events.push({
          t: Math.round(performance.now() * 10) / 10,
          type,
          target: name,
          isTrusted: e.isTrusted,
          ctor: e.constructor && e.constructor.name,
          key: e.key || null,
          code: e.code || null,
          inputType: e.inputType || null,
          data: e.data || null,
          button: e.button ?? null,
          buttons: e.buttons ?? null,
          pointerType: e.pointerType || null,
          clientX: Number.isFinite(e.clientX) ? Math.round(e.clientX) : null,
          clientY: Number.isFinite(e.clientY) ? Math.round(e.clientY) : null,
          movementX: Number.isFinite(e.movementX) ? e.movementX : null,
          movementY: Number.isFinite(e.movementY) ? e.movementY : null,
          value: e.target && 'value' in e.target ? String(e.target.value).slice(0, 80) : null,
        });
      }, true);
    }
  </script>
</body>
</html>`;

function summarize(events) {
  const byType = {};
  const untrusted = [];
  for (const e of events) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (e.isTrusted === false) untrusted.push(e);
  }
  const sequence = events.map((e) => `${e.type}:${e.target}:${e.isTrusted ? 'T' : 'F'}`);
  return {
    count: events.length,
    by_type: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => a.localeCompare(b))),
    untrusted_count: untrusted.length,
    untrusted_types: [...new Set(untrusted.map((e) => e.type))].sort(),
    first_40_sequence: sequence.slice(0, 40),
    last_20_sequence: sequence.slice(-20),
  };
}

function eventSamples(events) {
  return events.map((e) => ({
    t: e.t,
    type: e.type,
    target: e.target,
    isTrusted: e.isTrusted,
    ctor: e.ctor,
    key: e.key,
    code: e.code,
    inputType: e.inputType,
    data: e.data,
    button: e.button,
    buttons: e.buttons,
    pointerType: e.pointerType,
    clientX: e.clientX,
    clientY: e.clientY,
    movementX: e.movementX,
    movementY: e.movementY,
    value: e.value,
  }));
}

mkdirSync(OUT_DIR, { recursive: true });

const s = await WSession.start({
  label: LABEL,
  proxy: 'direct',
  injectStorage: false,
  completeNetworkCapture: false,
  record: false,
});

let report;
try {
  await s.page.goto(`data:text/html,${encodeURIComponent(html)}`, { waitUntil: 'domcontentloaded' });

  const fillResult = await s.fill('email', 'probe@example.com');
  const preSelectDom = await s.page.evaluate(`Array.from(document.querySelectorAll('select')).map((s,i)=>({i,name:s.name,id:s.id,selectedIndex:s.selectedIndex,options:Array.from(s.options).map(o=>o.text)}))`).catch((e) => ({ error: String(e.message || e).slice(0, 200) }));
  const selectResult = await s.select('country', 'United States');
  const clickResult = await s.click('Agree & Join');
  await s.page.waitForTimeout(500).catch(() => {});

  const events = await s.page.evaluate('window.__events || []');
  report = {
    generated_at: new Date().toISOString(),
    scope: 'local Weles action event sequence probe; no LinkedIn navigation',
    operations: { fillResult, clickResult, preSelectDom, selectResult },
    summary: summarize(events),
    events: eventSamples(events),
    linkedin_relevance: {
      cdp_keyboard_events_observed: events.some((e) => e.type === 'keydown' && e.isTrusted === true),
      synthetic_js_change_observed: events.some((e) => e.type === 'change' && e.isTrusted === false),
      untrusted_events_present: events.some((e) => e.isTrusted === false),
      note: 'isTrusted=true is necessary but not sufficient. CDP events can still differ from OS events in provenance, movement deltas, timing, and compositor/device metadata.',
    },
  };
} finally {
  await s.close().catch(() => {});
}

const outPath = join(OUT_DIR, `action_event_probe_${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({
  outPath,
  operations: report.operations,
  event_count: report.summary.count,
  untrusted_count: report.summary.untrusted_count,
  untrusted_types: report.summary.untrusted_types,
  first_20_sequence: report.summary.first_40_sequence.slice(0, 20),
}, null, 2));
