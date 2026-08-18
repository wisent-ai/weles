// Diff EVERYTHING between two runs (e.g. keeper-success vs trajectory-failure).
//
// Usage:
//   node scripts/debug/diff/diff_runs.mjs <runA> <runB>
// where each <run> is either:
//   - a recordings/<label>/ directory (network.ndjson + session_meta.json + account.json), or
//   - a .work/inst/<label>.json property-trap dump, or
//   - both, comma-joined: recordings/<label>,.work/inst/<label>.json
//
// Diffs: network requests (only-in-A / only-in-B by method+path, status deltas,
// cookie-header presence on signup/createAccount/checkpoint/recaptcha requests),
// the property-trap access surface, and persona/fingerprint fields.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const KEY_URL_RE = /signup|createAccount|checkpoint|challenge|recaptcha|uas\/|voyager/i;
const PERSONA_KEYS = 'os,browser,platform,language,timezone,userAgentOs,chromeVersion,hardwareConcurrency,audioSampleRate,canvasSeed'.split(',');

function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } }
function urlPath(u) { try { const x = new URL(u); return x.host + x.pathname; } catch { return u; } }

function loadRun(spec) {
  const out = { net: [], inst: null, persona: null, cookies: [], label: spec };
  for (const part of spec.split(',')) {
    if (!existsSync(part)) continue;
    if (part.endsWith('.json') && part.includes('/inst/')) {
      out.inst = readJson(part);
    } else {
      const nd = join(part, 'network.ndjson');
      if (existsSync(nd)) {
        for (const line of readFileSync(nd, 'utf8').split('\n')) {
          if (!line.trim()) continue;
          try { out.net.push(JSON.parse(line)); } catch { /* skip */ }
        }
      }
      const meta = readJson(join(part, 'session_meta.json'));
      if (meta) out.persona = meta.persona ?? meta;
      const acct = readJson(join(part, 'account.json'));
      if (acct && acct.metadata) {
        if (acct.metadata.persona) out.persona = acct.metadata.persona;
        if (Array.isArray(acct.metadata.cookies)) out.cookies = acct.metadata.cookies;
      }
    }
  }
  return out;
}

function reqIndex(net) {
  const m = new Map();
  for (const e of net) {
    if (!e.url || !e.method) continue;
    const k = `${e.method} ${urlPath(e.url)}`;
    if (!m.has(k)) m.set(k, { statuses: new Set() });
    if (typeof e.status === 'number') m.get(k).statuses.add(e.status);
  }
  return m;
}

function instProps(inst) {
  const s = new Set();
  if (!inst) return s;
  const arr = Array.isArray(inst) ? inst : (Array.isArray(inst.accesses) ? inst.accesses : []);
  for (const a of arr) { if (a && a.o && a.p) s.add(`${a.o}:${a.p}`); }
  return s;
}

function diffSets(a, b) {
  return { onlyA: [...a].filter((x) => !b.has(x)).sort(), onlyB: [...b].filter((x) => !a.has(x)).sort() };
}

function cookieOn(net) {
  const out = {};
  for (const e of net) {
    if (!e.url || !KEY_URL_RE.test(e.url)) continue;
    const h = e.headers || {};
    const ck = h.cookie || h.Cookie || '';
    out[`${e.method} ${urlPath(e.url)}`] = ck ? ck.split(';').map((c) => c.trim().split('=')[0]).filter(Boolean) : [];
  }
  return out;
}

function main() {
  const [, , specA, specB] = process.argv;
  if (!specA || !specB) { console.error('usage: diff_runs.mjs <runA> <runB>'); process.exit(1); }
  const A = loadRun(specA);
  const B = loadRun(specB);
  const idxA = reqIndex(A.net);
  const idxB = reqIndex(B.net);
  const keysA = new Set(idxA.keys());
  const keysB = new Set(idxB.keys());
  const netDiff = diffSets(keysA, keysB);

  const statusDeltas = [];
  for (const k of keysA) {
    if (!keysB.has(k)) continue;
    const sa = [...idxA.get(k).statuses].sort().join(',');
    const sb = [...idxB.get(k).statuses].sort().join(',');
    if (sa !== sb) statusDeltas.push({ req: k, A: sa, B: sb });
  }

  const propDiff = diffSets(instProps(A.inst), instProps(B.inst));

  const personaDiff = [];
  for (const k of PERSONA_KEYS) {
    const av = A.persona ? JSON.stringify(A.persona[k]) : undefined;
    const bv = B.persona ? JSON.stringify(B.persona[k]) : undefined;
    if (av !== bv) personaDiff.push({ field: k, A: av, B: bv });
  }
  const gpuA = A.persona && A.persona.gpu ? JSON.stringify(A.persona.gpu) : undefined;
  const gpuB = B.persona && B.persona.gpu ? JSON.stringify(B.persona.gpu) : undefined;
  if (gpuA !== gpuB) personaDiff.push({ field: 'gpu', A: gpuA, B: gpuB });

  const report = {
    runA: { label: A.label, requests: A.net.length, distinctReqs: keysA.size, instProps: instProps(A.inst).size, cookieJar: A.cookies.length },
    runB: { label: B.label, requests: B.net.length, distinctReqs: keysB.size, instProps: instProps(B.inst).size, cookieJar: B.cookies.length },
    network: {
      keyRequestsOnlyInA: netDiff.onlyA.filter((k) => KEY_URL_RE.test(k)),
      keyRequestsOnlyInB: netDiff.onlyB.filter((k) => KEY_URL_RE.test(k)),
      otherOnlyInA: netDiff.onlyA.filter((k) => !KEY_URL_RE.test(k)).slice(0, 40),
      otherOnlyInB: netDiff.onlyB.filter((k) => !KEY_URL_RE.test(k)).slice(0, 40),
      statusDeltas,
      cookiesA: cookieOn(A.net),
      cookiesB: cookieOn(B.net),
    },
    propertyTrap: { onlyInA: propDiff.onlyA.slice(0, 60), onlyInB: propDiff.onlyB.slice(0, 60) },
    persona: personaDiff,
  };
  console.log(JSON.stringify(report, null, 2));
}

main();
