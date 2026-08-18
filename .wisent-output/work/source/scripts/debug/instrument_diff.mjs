// Diff two property-trap dumps (chrome=human reference vs weles=trajectory).
//
// Both files share the WSession instrument format:
//   { accesses: [{url, log: [{t,o,p,vt,vs,s},...]}, ...], requests: [...] }
//
// Usage:
//   node instrument_diff.mjs <chrome.json> <weles.json>
//
// Reduces each side to: per-(o,p) access counts, addEventListener types,
// XHR/fetch URLs, behavioral event counts seen via addEventListener wraps,
// SubtleCrypto.encrypt payload sizes. Prints:
//   - properties accessed by page in chrome but never in weles (missing telemetry)
//   - properties accessed by weles but not chrome (extra signals we emit)
//   - addEventListener types only on one side (events the page subscribed to)
//   - XHR/fetch URL set diff (request shape difference)
//   - SubtleCrypto blob count diff (Arkose-shape difference)

import { readFileSync } from 'node:fs';

const [a, b] = process.argv.slice(2);
if (!a || !b) { console.error('usage: node instrument_diff.mjs <chrome.json> <weles.json>'); process.exit(1); }

function load(path) {
  const j = JSON.parse(readFileSync(path, 'utf-8'));
  const events = [];
  for (const frame of (j.accesses ?? [])) {
    for (const e of (frame.log ?? [])) events.push({ ...e, _url: frame.url });
  }
  return { meta: { which: j.which, platform: j.platform, target: j.target }, events, requests: j.requests ?? [] };
}

function reduce(events) {
  const propAccess = new Map();
  const eventListeners = new Map();
  const xhrUrls = new Map();
  const fnInspect = new Map();
  const subtleCryptoSizes = [];
  const subtlePayloads = [];
  const audioContextCalls = [];
  const canvasFingerprintCalls = [];

  for (const e of events) {
    if (e.o === 'EventTarget' && e.p?.startsWith('addEventListener:')) {
      const t = e.p.slice('addEventListener:'.length);
      eventListeners.set(t, (eventListeners.get(t) || 0) + 1);
      continue;
    }
    if (e.o === 'XHR' && e.p?.startsWith('open:')) {
      const url = (e.vs || '').replace(/[?#].*$/, ''); // dedupe by path, drop query
      xhrUrls.set(url, (xhrUrls.get(url) || 0) + 1);
      continue;
    }
    if (e.o === 'Function' && e.p?.startsWith('toString:')) {
      const name = e.p.slice('toString:'.length);
      fnInspect.set(name, (fnInspect.get(name) || 0) + 1);
      continue;
    }
    if (e.o === 'SubtleCrypto' && e.p?.startsWith('encrypt:')) {
      subtleCryptoSizes.push((e.vs || '').length);
      subtlePayloads.push(e.vs || '');
      continue;
    }
    if (e.o === 'OfflineAudioContext') { audioContextCalls.push(e.p); continue; }
    if (e.o === 'Canvas') { canvasFingerprintCalls.push(e.p); continue; }
    const k = e.o + '.' + e.p;
    propAccess.set(k, (propAccess.get(k) || 0) + 1);
  }

  return {
    totalEvents: events.length,
    propAccess,
    eventListeners,
    xhrUrls,
    fnInspect,
    subtleCrypto: { count: subtleCryptoSizes.length, sizes: subtleCryptoSizes, payloads: subtlePayloads.slice(0, 3) },
    audioContextCalls,
    canvasFingerprintCalls,
  };
}

function diffSets(A, B, labelA, labelB) {
  const onlyA = [...A.keys()].filter(k => !B.has(k)).sort();
  const onlyB = [...B.keys()].filter(k => !A.has(k)).sort();
  const both = [...A.keys()].filter(k => B.has(k));
  const ratioDiff = [];
  for (const k of both) {
    const ra = A.get(k), rb = B.get(k);
    if (ra && rb && Math.max(ra, rb) / Math.min(ra, rb) >= 5) ratioDiff.push({ k, [labelA]: ra, [labelB]: rb });
  }
  return { onlyA, onlyB, ratioDiff };
}

const A = load(a);
const B = load(b);
const RA = reduce(A.events);
const RB = reduce(B.events);

console.log(`\n=== A (${a}) ===`);
console.log(`platform=${A.meta.platform} which=${A.meta.which} target=${A.meta.target?.slice(0, 80)}`);
console.log(`events=${RA.totalEvents}, propAccess=${RA.propAccess.size}, eventListeners=${RA.eventListeners.size}, xhrUrls=${RA.xhrUrls.size}, fnInspect=${RA.fnInspect.size}`);
console.log(`subtleCrypto.count=${RA.subtleCrypto.count}, audioContext=${RA.audioContextCalls.length}, canvas=${RA.canvasFingerprintCalls.length}`);

console.log(`\n=== B (${b}) ===`);
console.log(`platform=${B.meta.platform} which=${B.meta.which} target=${B.meta.target?.slice(0, 80)}`);
console.log(`events=${RB.totalEvents}, propAccess=${RB.propAccess.size}, eventListeners=${RB.eventListeners.size}, xhrUrls=${RB.xhrUrls.size}, fnInspect=${RB.fnInspect.size}`);
console.log(`subtleCrypto.count=${RB.subtleCrypto.count}, audioContext=${RB.audioContextCalls.length}, canvas=${RB.canvasFingerprintCalls.length}`);

const propD = diffSets(RA.propAccess, RB.propAccess, 'A', 'B');
console.log(`\n=== PROPERTY-ACCESS DELTA ===`);
console.log(`only in A (${propD.onlyA.length}):`); for (const k of propD.onlyA.slice(0, 80)) console.log(`  ${k}  count=${RA.propAccess.get(k)}`);
if (propD.onlyA.length > 80) console.log(`  ... +${propD.onlyA.length - 80} more`);
console.log(`only in B (${propD.onlyB.length}):`); for (const k of propD.onlyB.slice(0, 80)) console.log(`  ${k}  count=${RB.propAccess.get(k)}`);
if (propD.onlyB.length > 80) console.log(`  ... +${propD.onlyB.length - 80} more`);
if (propD.ratioDiff.length) {
  console.log(`access-count ratio >5x:`);
  for (const r of propD.ratioDiff.slice(0, 30)) console.log(`  ${r.k}  A=${r.A} B=${r.B}`);
}

const elD = diffSets(RA.eventListeners, RB.eventListeners, 'A', 'B');
console.log(`\n=== addEventListener TYPES (which events does the page subscribe to?) ===`);
console.log(`only in A: ${elD.onlyA.join(', ') || '(none)'}`);
console.log(`only in B: ${elD.onlyB.join(', ') || '(none)'}`);

const xhrD = diffSets(RA.xhrUrls, RB.xhrUrls, 'A', 'B');
console.log(`\n=== XHR URL SET DELTA ===`);
console.log(`only in A (${xhrD.onlyA.length}):`); for (const u of xhrD.onlyA.slice(0, 30)) console.log(`  ${u}`);
console.log(`only in B (${xhrD.onlyB.length}):`); for (const u of xhrD.onlyB.slice(0, 30)) console.log(`  ${u}`);

const fnD = diffSets(RA.fnInspect, RB.fnInspect, 'A', 'B');
console.log(`\n=== Function.toString INSPECTIONS (anti-bot probes for [native code] tampering) ===`);
console.log(`only in A: ${fnD.onlyA.slice(0, 50).join(', ') || '(none)'}${fnD.onlyA.length > 50 ? ` ... +${fnD.onlyA.length - 50}` : ''}`);
console.log(`only in B: ${fnD.onlyB.slice(0, 50).join(', ') || '(none)'}${fnD.onlyB.length > 50 ? ` ... +${fnD.onlyB.length - 50}` : ''}`);

console.log(`\n=== SUBTLE-CRYPTO ENCRYPT (anti-bot fingerprint blobs) ===`);
console.log(`A: ${RA.subtleCrypto.count} encrypts, sizes p50=${RA.subtleCrypto.sizes.sort((x,y)=>x-y)[Math.floor(RA.subtleCrypto.sizes.length/2)] ?? 0}`);
console.log(`B: ${RB.subtleCrypto.count} encrypts, sizes p50=${RB.subtleCrypto.sizes.sort((x,y)=>x-y)[Math.floor(RB.subtleCrypto.sizes.length/2)] ?? 0}`);
