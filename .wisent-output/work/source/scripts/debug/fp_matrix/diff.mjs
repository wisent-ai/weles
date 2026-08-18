#!/usr/bin/env node
// Full per-field PASS-vs-FAIL diff over the merged inst.json shape.
//
// Usage:
//   node scripts/debug/fp_matrix/diff.mjs <pass.inst.json> <fail.inst.json>
//
// Reads each inst.json (the merged dump produced by
// src/session/wsession-helpers/net_record.ts buildDumpPayload) and emits a
// per-field delta to .work/inst/diff_<ts>.md. Every field handled by a shape-
// aware comparator: scalars get scalar-diff, flat objects get key-by-key,
// event-array channels get bag-by-key.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES_ROOT = join(__dirname, '..', '..', '..');
const INST_DIR = join(WELES_ROOT, '.work', 'inst');

const argA = process.argv[2];
const argB = process.argv[3];
if (!argA || !argB) {
  console.error('usage: diff.mjs <pass.inst.json> <fail.inst.json>');
  process.exit(2);
}

mkdirSync(INST_DIR, { recursive: true });
const A = JSON.parse(readFileSync(argA, 'utf-8'));
const B = JSON.parse(readFileSync(argB, 'utf-8'));

const md = [];
md.push(`# Full per-field PASS-vs-FAIL diff`);
md.push('');
md.push(`A = \`${basename(argA)}\``);
md.push(`B = \`${basename(argB)}\``);
md.push('');

function show(v) {
  const s = JSON.stringify(v);
  if (s === undefined) return '<absent>';
  return s.length > 400 ? s.slice(0, 400) + '…' : s;
}

function diffScalar(name, a, b) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  md.push(`### \`${name}\``);
  md.push('');
  md.push('| side | value |');
  md.push('|---|---|');
  md.push(`| A | \`${show(a)}\` |`);
  md.push(`| B | \`${show(b)}\` |`);
  md.push('');
}

function diffObjectFlat(name, a, b) {
  const ao = a && typeof a === 'object' ? a : {};
  const bo = b && typeof b === 'object' ? b : {};
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  const rows = [];
  for (const k of keys) {
    if (JSON.stringify(ao[k]) !== JSON.stringify(bo[k])) {
      rows.push([k, show(ao[k]).slice(0, 200), show(bo[k]).slice(0, 200)]);
    }
  }
  if (!rows.length) return;
  md.push(`### \`${name}\` (object delta — ${rows.length} keys differ)`);
  md.push('');
  md.push('| key | A | B |');
  md.push('|---|---|---|');
  for (const r of rows) md.push(`| ${r[0]} | \`${r[1]}\` | \`${r[2]}\` |`);
  md.push('');
}

function bagBy(arr, keyFn) {
  const m = new Map();
  if (!Array.isArray(arr)) return m;
  for (const item of arr) {
    let k;
    if (typeof keyFn === 'function') k = keyFn(item);
    else if (item && typeof item === 'object') k = item[keyFn];
    else k = undefined;
    if (k === null || k === undefined) continue;
    const ks = String(k);
    let prev = 0;
    if (m.has(ks)) prev = m.get(ks);
    m.set(ks, prev + 1);
  }
  return m;
}

function countIn(m, k) {
  if (m.has(k)) return m.get(k);
  return 0;
}

function diffBag(name, a, b, keyFn) {
  const ma = bagBy(a, keyFn);
  const mb = bagBy(b, keyFn);
  const all = new Set([...ma.keys(), ...mb.keys()]);
  const onlyA = [], onlyB = [], skew = [];
  for (const k of all) {
    const ca = countIn(ma, k);
    const cb = countIn(mb, k);
    if (ca > 0 && cb === 0) onlyA.push([k, ca]);
    else if (cb > 0 && ca === 0) onlyB.push([k, cb]);
    else if (ca !== cb) {
      const hi = Math.max(ca, cb);
      const lo = Math.max(1, Math.min(ca, cb));
      if (hi / lo >= 3) skew.push([k, ca, cb]);
    }
  }
  if (!onlyA.length && !onlyB.length && !skew.length) return;
  md.push(`### \`${name}\` (bag delta — only-in-A: ${onlyA.length}, only-in-B: ${onlyB.length}, skewed: ${skew.length})`);
  md.push('');
  if (onlyA.length) {
    md.push('only in A:');
    md.push('');
    for (const [k, c] of onlyA.slice(0, 40)) md.push(`- \`${k}\` × ${c}`);
    if (onlyA.length > 40) md.push(`- _+${onlyA.length - 40} more_`);
    md.push('');
  }
  if (onlyB.length) {
    md.push('only in B:');
    md.push('');
    for (const [k, c] of onlyB.slice(0, 40)) md.push(`- \`${k}\` × ${c}`);
    if (onlyB.length > 40) md.push(`- _+${onlyB.length - 40} more_`);
    md.push('');
  }
  if (skew.length) {
    md.push('count skew (≥3×):');
    md.push('');
    md.push('| key | A | B |');
    md.push('|---|---|---|');
    for (const [k, ca, cb] of skew.slice(0, 30)) md.push(`| \`${k}\` | ${ca} | ${cb} |`);
    md.push('');
  }
}

function diffAccessesField(name, a, b) {
  const flatten = (frames) => {
    const m = new Map();
    if (!Array.isArray(frames)) return m;
    for (const f of frames) {
      const log = Array.isArray(f.log) ? f.log : [];
      for (const e of log) {
        const o = e.o ? String(e.o) : '?';
        let p = '?';
        if (typeof e.p === 'string') p = e.p.split(':')[0];
        const k = o + '.' + p;
        let prev = 0;
        if (m.has(k)) prev = m.get(k);
        m.set(k, prev + 1);
      }
    }
    return m;
  };
  const ma = flatten(a);
  const mb = flatten(b);
  const all = new Set([...ma.keys(), ...mb.keys()]);
  const onlyA = [], onlyB = [];
  for (const k of all) {
    const ca = countIn(ma, k);
    const cb = countIn(mb, k);
    if (ca > 0 && cb === 0) onlyA.push([k, ca]);
    else if (cb > 0 && ca === 0) onlyB.push([k, cb]);
  }
  if (!onlyA.length && !onlyB.length) return;
  md.push(`### \`${name}\` (property-trap access keys)`);
  md.push('');
  md.push(`only in A (${onlyA.length}):`);
  md.push('');
  for (const [k, c] of onlyA.slice(0, 80)) md.push(`- \`${k}\` × ${c}`);
  if (onlyA.length > 80) md.push(`- _+${onlyA.length - 80} more_`);
  md.push('');
  md.push(`only in B (${onlyB.length}):`);
  md.push('');
  for (const [k, c] of onlyB.slice(0, 80)) md.push(`- \`${k}\` × ${c}`);
  if (onlyB.length > 80) md.push(`- _+${onlyB.length - 80} more_`);
  md.push('');
}

md.push('## Session header');
md.push('');
md.push('| field | A | B |');
md.push('|---|---|---|');
for (const f of 'label,started_at,closed_at,cdp_firehose_overflow'.split(',')) {
  md.push(`| ${f} | \`${show(A[f])}\` | \`${show(B[f])}\` |`);
}
md.push('');

for (const f of 'host,persona,proxy,versions,browser_version'.split(',')) {
  diffObjectFlat(f, A[f], B[f]);
}

const SCALAR_FIELDS = 'system_info,process_info,histograms,navigation_history,dom_snapshot_error,dom_pierced_tree_error,heap_snapshot_error,webaudio_error,animations_error,indexed_db_error,cdp_tracing_error,js_coverage_error,css_coverage_error,worker_surfaces_error,pcap'.split(',');
for (const f of SCALAR_FIELDS) diffScalar(f, A[f], B[f]);

diffAccessesField('accesses', A.accesses, B.accesses);

function urlNoQuery(u) {
  if (typeof u !== 'string') return '';
  return u.split('?')[0];
}

diffBag('requests.method-url', A.requests, B.requests, (e) => `${e.method || e.phase}:${urlNoQuery(e.url)}`);
diffBag('console.text', A.console, B.console, (e) => `${e.type}:${typeof e.text === 'string' ? e.text.slice(0, 120) : ''}`);
diffBag('pageerrors.name', A.pageerrors, B.pageerrors, (e) => `${e.name}:${typeof e.message === 'string' ? e.message.slice(0, 120) : ''}`);
diffBag('service_workers.url', A.service_workers, B.service_workers, 'url');
diffBag('cdp_targets.type-url', A.cdp_targets, B.cdp_targets, (e) => `${e.phase}:${e.info && e.info.type}:${urlNoQuery(e.info && e.info.url)}`);
diffBag('cdp_frames.url', A.cdp_frames, B.cdp_frames, (e) => `${e.phase}:${urlNoQuery(e.url)}`);
diffBag('cdp_network.phase-url', A.cdp_network, B.cdp_network, (e) => {
  let path = '';
  if (e.headers && typeof e.headers[':path'] === 'string') path = e.headers[':path'];
  else if (typeof e.url === 'string') path = e.url;
  return `${e.phase}:${urlNoQuery(path)}`;
});
diffBag('webaudio.phase', A.webaudio, B.webaudio, 'phase');
diffBag('animations.phase', A.animations, B.animations, 'phase');
diffBag('indexed_db.name', A.indexed_db, B.indexed_db, 'name');
diffBag('page_events.phase', A.page_events, B.page_events, (e) => `${e.phase}:${e.name || e.type || ''}`);
diffBag('runtime.phase', A.runtime, B.runtime, (e) => `${e.phase}:${e.type || ''}`);
diffBag('log_entries.source-level', A.log_entries, B.log_entries, (e) => `${e.entry && e.entry.source}:${e.entry && e.entry.level}`);
diffBag('security.phase', A.security, B.security, 'phase');
diffBag('storage_events.phase', A.storage_events, B.storage_events, 'phase');
diffBag('playwright_events.phase', A.playwright_events, B.playwright_events, 'phase');
diffBag('cdp_firehose.domain-event', A.cdp_firehose, B.cdp_firehose, (e) => `${e.domain}.${e.event}`);
diffBag('worker_surfaces.targetType-url', A.worker_surfaces, B.worker_surfaces, (e) => `${e.targetType}:${e.targetUrl || ''}`);
diffBag('worker_events.phase', A.worker_events, B.worker_events, 'phase');
diffBag('stdout.level', A.stdout, B.stdout, 'level');

md.push('## High-cardinality channel counts');
md.push('');
md.push('| field | len A | len B |');
md.push('|---|---|---|');
for (const f of 'cdp_metrics,storage_history,process_history,cdp_tracing,dom_counters,sibling_files'.split(',')) {
  const la = Array.isArray(A[f]) ? A[f].length : 0;
  const lb = Array.isArray(B[f]) ? B[f].length : 0;
  if (la === lb) continue;
  md.push(`| ${f} | ${la} | ${lb} |`);
}
md.push('');

diffObjectFlat('host_snapshots', A.host_snapshots, B.host_snapshots);

const jsUrls = (cov) => {
  const result = cov && Array.isArray(cov.result) ? cov.result : [];
  const out = new Set();
  for (const r of result) if (r && r.url) out.add(r.url);
  return out;
};
const cssIds = (cov) => {
  const cu = cov && Array.isArray(cov.coverage) ? cov.coverage : [];
  const out = new Set();
  for (const r of cu) if (r && r.styleSheetId) out.add(r.styleSheetId);
  return out;
};
const toItems = (s, keyName) => [...s].map((v) => ({ [keyName]: v }));
diffBag('js_coverage.urls', toItems(jsUrls(A.js_coverage), 'url'), toItems(jsUrls(B.js_coverage), 'url'), 'url');
diffBag('css_coverage.stylesheets', toItems(cssIds(A.css_coverage), 'id'), toItems(cssIds(B.css_coverage), 'id'), 'id');

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const out = join(INST_DIR, `diff_${ts}.md`);
writeFileSync(out, md.join('\n') + '\n');
console.log(`wrote ${out}`);
