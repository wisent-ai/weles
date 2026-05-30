#!/usr/bin/env node
// Multi-way differ over .work/inst/matrix.jsonl. Partitions captures by
// outcome, computes for each surface key (object.property) the count of
// captures-it-appeared-in within each partition, and surfaces the keys with
// the highest contrast between partitions:
//
//   "in 100% of GAUNTLET captures, 0% of PASS captures"
//   "in 0% of GAUNTLET captures, 100% of PASS captures"
//
// Output: matrix_summary.md with the consistent deltas.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES_ROOT = join(__dirname, '..', '..', '..');
const MATRIX = join(WELES_ROOT, '.work', 'inst', 'matrix.jsonl');
const OUT = join(WELES_ROOT, '.work', 'inst', 'matrix_summary.md');

const rows = readFileSync(MATRIX, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
console.log(`loaded ${rows.length} matrix rows`);

const byOutcome = {};
for (const r of rows) {
  if (!byOutcome[r.outcome]) byOutcome[r.outcome] = [];
  byOutcome[r.outcome].push(r);
}

function buildPresence(rowsForPartition) {
  const presence = new Map();
  for (const r of rowsForPartition) {
    const keys = Array.isArray(r.surfaceKeys) ? r.surfaceKeys : [];
    for (const k of keys) {
      const cur = presence.has(k) ? presence.get(k) : 0;
      presence.set(k, cur + 1);
    }
  }
  return presence;
}

const presence = {};
for (const [outcome, rs] of Object.entries(byOutcome)) {
  presence[outcome] = { count: rs.length, keys: buildPresence(rs) };
}

const FAIL_OUTCOMES = ['GAUNTLET_STUCK', 'GAUNTLET_OTHER'];
const PASS_OUTCOMES = ['ULTIMATE_PASS', 'PHONE_VERIFY', 'CREATEACCOUNT_NO_GAUNTLET'];

const failKeys = new Map();
let failN = 0;
for (const o of FAIL_OUTCOMES) {
  if (!presence[o]) continue;
  failN += presence[o].count;
  for (const [k, n] of presence[o].keys) {
    const cur = failKeys.has(k) ? failKeys.get(k) : 0;
    failKeys.set(k, cur + n);
  }
}
const passKeys = new Map();
let passN = 0;
for (const o of PASS_OUTCOMES) {
  if (!presence[o]) continue;
  passN += presence[o].count;
  for (const [k, n] of presence[o].keys) {
    const cur = passKeys.has(k) ? passKeys.get(k) : 0;
    passKeys.set(k, cur + n);
  }
}

console.log(`partitions: FAIL(GAUNTLET)=${failN} captures, PASS(PASS|PHONE_VERIFY|CREATEACCOUNT_NO_GAUNTLET)=${passN} captures`);

if (failN === 0 || passN === 0) {
  const lines = [
    '# Fingerprint matrix summary',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Captures by outcome:`,
    ...Object.entries(presence).map(([o, p]) => `- ${o}: ${p.count}`),
    '',
    `**Cannot compute consistent-delta**: need at least one capture in each side of the comparison.`,
    failN === 0 ? '- FAIL side (GAUNTLET) is empty.' : '',
    passN === 0 ? '- PASS side (PASS|PHONE_VERIFY|CREATEACCOUNT_NO_GAUNTLET) is empty.' : '',
    '',
    'To populate: run more keeper variations (different persona/URL/proxy) and re-run collect.mjs.',
  ].filter(Boolean);
  writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`wrote ${OUT}`);
  process.exit(0);
}

const allKeys = new Set([...failKeys.keys(), ...passKeys.keys()]);
const stats = [];
for (const k of allKeys) {
  const f = failKeys.has(k) ? failKeys.get(k) : 0;
  const p = passKeys.has(k) ? passKeys.get(k) : 0;
  const fRatio = f / failN;
  const pRatio = p / passN;
  stats.push({ k, f, p, fRatio, pRatio, delta: pRatio - fRatio });
}

const passOnly = stats.filter(s => s.fRatio === 0 && s.pRatio > 0).sort((a, b) => b.pRatio - a.pRatio);
const failOnly = stats.filter(s => s.pRatio === 0 && s.fRatio > 0).sort((a, b) => b.fRatio - a.fRatio);
const skewedPass = stats.filter(s => s.fRatio > 0 && s.pRatio > 0 && s.delta > 0.5).sort((a, b) => b.delta - a.delta);
const skewedFail = stats.filter(s => s.fRatio > 0 && s.pRatio > 0 && s.delta < -0.5).sort((a, b) => a.delta - b.delta);

const md = [];
md.push('# Fingerprint matrix summary');
md.push('');
md.push(`Generated: ${new Date().toISOString()}`);
md.push('');
md.push('## Capture counts by outcome');
md.push('');
md.push('| outcome | n |');
md.push('|---|---|');
for (const [o, p] of Object.entries(presence).sort()) md.push(`| ${o} | ${p.count} |`);
md.push('');
md.push(`## Comparison sets`);
md.push(`- FAIL = ${FAIL_OUTCOMES.join(', ')}  →  ${failN} captures`);
md.push(`- PASS = ${PASS_OUTCOMES.join(', ')}  →  ${passN} captures`);
md.push('');
md.push(`## Surface keys ONLY in PASS captures (page reads these when not gauntleted, never when gauntleted)`);
md.push('');
md.push('| key | PASS hit-rate |');
md.push('|---|---|');
for (const s of passOnly.slice(0, 60)) md.push(`| \`${s.k}\` | ${(s.pRatio * 100).toFixed(0)}% (${s.p}/${passN}) |`);
if (passOnly.length > 60) md.push(`| _...+${passOnly.length - 60} more_ | |`);
md.push('');
md.push(`## Surface keys ONLY in FAIL captures (page reads these when gauntleted, never when passing)`);
md.push('');
md.push('| key | FAIL hit-rate |');
md.push('|---|---|');
for (const s of failOnly.slice(0, 60)) md.push(`| \`${s.k}\` | ${(s.fRatio * 100).toFixed(0)}% (${s.f}/${failN}) |`);
if (failOnly.length > 60) md.push(`| _...+${failOnly.length - 60} more_ | |`);
md.push('');
md.push(`## Surface keys SKEWED toward PASS (in both partitions but >50pp more common in PASS)`);
md.push('');
md.push('| key | PASS | FAIL | delta |');
md.push('|---|---|---|---|');
for (const s of skewedPass.slice(0, 40)) md.push(`| \`${s.k}\` | ${(s.pRatio * 100).toFixed(0)}% | ${(s.fRatio * 100).toFixed(0)}% | +${(s.delta * 100).toFixed(0)}pp |`);
md.push('');
md.push(`## Surface keys SKEWED toward FAIL (in both partitions but >50pp more common in FAIL)`);
md.push('');
md.push('| key | PASS | FAIL | delta |');
md.push('|---|---|---|---|');
for (const s of skewedFail.slice(0, 40)) md.push(`| \`${s.k}\` | ${(s.pRatio * 100).toFixed(0)}% | ${(s.fRatio * 100).toFixed(0)}% | ${(s.delta * 100).toFixed(0)}pp |`);
md.push('');
md.push('## Raw capture index');
md.push('');
md.push('| label | browser | os | initialUrl | outcome | file |');
md.push('|---|---|---|---|---|---|');
for (const r of rows.sort((a, b) => String(a.outcome).localeCompare(String(b.outcome)))) {
  md.push(`| ${r.label} | ${r.browser ?? '?'} | ${r.os ?? '?'} | ${r.initialUrl ?? '?'} | ${r.outcome} | ${r.file} |`);
}
writeFileSync(OUT, md.join('\n') + '\n');
console.log(`wrote ${OUT}`);
console.log('');
console.log(`PASS-only keys: ${passOnly.length}  FAIL-only keys: ${failOnly.length}`);
console.log(`Skewed-pass (>50pp): ${skewedPass.length}  Skewed-fail (>50pp): ${skewedFail.length}`);
