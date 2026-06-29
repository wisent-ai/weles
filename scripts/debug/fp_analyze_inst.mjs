#!/usr/bin/env node
/**
 * Analyze a Weles inst.json for fingerprint anti-detect issues.
 *
 * Looks at the page-side access log and persona to find tells that
 * reCAPTCHA / PerimeterX / LinkedIn can use to flag automation.
 *
 * Usage:
 *   node scripts/debug/fp_analyze_inst.mjs <path/to/run.inst.json>
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES_ROOT = join(__dirname, '..', '..');
const OUT_DIR = join(WELES_ROOT, '.work', 'fp_analysis');

const instPath = process.argv[2];
if (!instPath) {
  console.error('usage: fp_analyze_inst.mjs <path/to/run.inst.json>');
  process.exit(2);
}

const inst = JSON.parse(readFileSync(instPath, 'utf-8'));
const persona = inst.persona ?? {};
const accesses = inst.accesses ?? [];
const flatLog = accesses.flatMap(a => (a.log ?? []).map(e => ({ url: a.url, ...e })));

const issues = [];
const findings = [];

function issue(severity, category, message, evidence = null) {
  issues.push({ severity, category, message, evidence });
}

function finding(category, message, value) {
  findings.push({ category, message, value });
}

// --- Persona summary ---
finding('persona', 'target OS', persona.os ?? 'unknown');
finding('persona', 'target browser', persona.browser ?? 'unknown');
finding('persona', 'platform', persona.platform ?? 'unknown');
finding('persona', 'screen', `${persona.screen?.width ?? '?'}x${persona.screen?.height ?? '?'} dpr=${persona.screen?.dpr ?? '?'}`);
finding('persona', 'GPU vendor', persona.gpu?.vendor ?? 'unknown');
finding('persona', 'GPU renderer', persona.gpu?.renderer ?? 'unknown');
finding('persona', 'hardwareConcurrency', persona.hardwareConcurrency ?? 'unknown');

// --- Helper: get last value for an object.property ---
function lastValue(obj, prop, filterFn) {
  const entries = flatLog.filter(e => e.o === obj && e.p === prop);
  const filtered = filterFn ? entries.filter(filterFn) : entries;
  return filtered.length ? filtered[filtered.length - 1] : null;
}

function allValues(obj, prop) {
  return flatLog.filter(e => e.o === obj && e.p === prop);
}

// --- 1. OS leak detection ---

// speechSynthesis voices leak the real OS
const voicesEntry = lastValue('speechSynthesis', 'getVoices');
if (voicesEntry) {
  const voicesStr = voicesEntry.vs ?? '';
  finding('speech', 'speechSynthesis voice count', (voicesStr.match(/"name"/g) || []).length);
  if (voicesStr.includes('com.apple.speech') || voicesStr.includes('com.apple.voice')) {
    issue('critical', 'os_leak', 'speechSynthesis voices expose macOS host while persona claims Windows', voicesStr.slice(0, 300));
  }
  if (voicesStr.includes('Microsoft') || voicesStr.includes('microsoft')) {
    finding('speech', 'speechSynthesis voices look Windows', true);
  }
}

// --- 2. Wrapped native API (init script leaks) ---

const wrappedEntries = flatLog.filter(e => e.s && (
  e.s.includes('wrapGetters') ||
  e.s.includes('debugger eval code') ||
  e.s.includes('property_trap') ||
  e.s.includes('input_recorder')
));

if (wrappedEntries.length) {
  issue('high', 'api_wrapping', `${wrappedEntries.length} property reads came from injected wrapper scripts`,
    [...new Set(wrappedEntries.slice(0, 10).map(e => `${e.o}.${e.p}`))]);
}

// --- 3. Empty objects where real API expected ---

const expectedApis = [
  { obj: 'navigator', prop: 'mediaDevices', expected: 'MediaDevices' },
  { obj: 'navigator', prop: 'permissions', expected: 'Permissions' },
  { obj: 'navigator', prop: 'mediaCapabilities', expected: 'MediaCapabilities' },
  { obj: 'navigator', prop: 'gpu', expected: 'GPU' },
];

for (const { obj, prop, expected } of expectedApis) {
  const entry = lastValue(obj, prop);
  if (entry && entry.vs === '{}') {
    issue('high', 'empty_api', `${obj}.${prop} returned empty object {} instead of ${expected}`, `${obj}.${prop}`);
  }
}

// --- 4. mimeTypes / plugins shape ---

const mimeTypes = lastValue('navigator', 'mimeTypes');
if (mimeTypes) {
  const mt = mimeTypes.vs ?? '';
  if (mt === '{}' || mt === '[]') {
    issue('medium', 'empty_api', 'navigator.mimeTypes is empty — unusual for Firefox/Chrome', mt);
  } else {
    finding('plugins', 'navigator.mimeTypes', mt.slice(0, 200));
  }
}

// --- 5. maxTouchPoints consistency ---

const mtp = lastValue('navigator', 'maxTouchPoints');
if (mtp) {
  const val = parseInt(mtp.vs, 10);
  finding('navigator', 'maxTouchPoints', val);
  if (persona.os === 'windows' && val > 0) {
    issue('medium', 'device_mismatch', `Windows desktop persona reports maxTouchPoints=${val} (expected 0 for most desktops)`, val);
  }
}

// --- 6. WebGL consistency ---

const webglVendor = lastValue('WebGL', '0x9245');
const webglRenderer = lastValue('WebGL', '0x9246');
if (webglVendor && webglRenderer) {
  finding('webgl', 'WebGL vendor', webglVendor.vs);
  finding('webgl', 'WebGL renderer', webglRenderer.vs);

  const renderer = webglRenderer.vs ?? '';
  if (persona.os === 'windows' && !renderer.includes('Direct3D')) {
    issue('high', 'webgl_mismatch', 'Windows persona but WebGL renderer lacks Direct3D', renderer);
  }
  if (persona.os === 'macos' && !renderer.includes('Metal') && !renderer.includes('Apple')) {
    issue('high', 'webgl_mismatch', 'macOS persona but WebGL renderer lacks Metal/Apple', renderer);
  }

  // Check if renderer matches persona.gpu.renderer
  const personaRenderer = persona.gpu?.renderer ?? '';
  if (personaRenderer && !renderer.includes(personaRenderer.split('(')[1]?.split(',')[0]?.trim() ?? 'NOMATCH')) {
    // loose check: Intel UHD 630 should appear in both
    const personaGpuName = (personaRenderer.match(/Intel\(R\)[^\s]+/i) || [])[0];
    const actualGpuName = (renderer.match(/Intel\(R\)[^\s]+/i) || [])[0];
    if (personaGpuName && actualGpuName && personaGpuName !== actualGpuName) {
      issue('high', 'webgl_mismatch', `persona GPU ${personaGpuName} != WebGL GPU ${actualGpuName}`, { persona: personaRenderer, webgl: renderer });
    }
  }
}

// --- 7. Screen consistency ---

const screenW = lastValue('screen', 'width');
const screenH = lastValue('screen', 'height');
const colorDepth = lastValue('screen', 'colorDepth');
if (screenW && screenH) {
  finding('screen', 'screen size', `${screenW.vs}x${screenH.vs}`);
  if (persona.os === 'macos' && colorDepth && parseInt(colorDepth.vs, 10) !== 30) {
    issue('medium', 'screen_mismatch', `macOS persona should report colorDepth=30 (Retina), got ${colorDepth.vs}`, colorDepth.vs);
  }
}

// --- 8. navigator.webdriver check ---

const webdriver = lastValue('navigator', 'webdriver');
if (webdriver) {
  finding('navigator', 'navigator.webdriver', webdriver.vs);
  if (webdriver.vs === 'true') {
    issue('critical', 'automation_flag', 'navigator.webdriver is true', webdriver.vs);
  }
}

// --- 9. JS errors from init scripts ---

const wrapErrors = flatLog.filter(e => e.vs && e.vs.includes("TypeError"));
if (wrapErrors.length) {
  issue('high', 'script_error', `${wrapErrors.length} TypeError entries in access log`, wrapErrors.slice(0, 3).map(e => e.vs));
}

// --- 10. Canvas / WebGL hashing consistency (basic) ---

const canvasHashes = [...new Set(flatLog.filter(e => e.o === 'Canvas' && e.p === 'toDataURL' && e.vs && e.vs.includes('h=')).map(e => {
  const m = e.vs.match(/h=([a-f0-9]+)/);
  return m ? m[1] : null;
}).filter(Boolean))];
findings.push({ category: 'canvas', message: 'distinct canvas hashes', value: canvasHashes.length });

// --- Report ---

mkdirSync(OUT_DIR, { recursive: true });
const outName = `fp_analysis_${basename(instPath).replace(/\.inst\.json$/, '')}_${new Date().toISOString().replace(/[:.]/g, '-')}.md`;
const outPath = join(OUT_DIR, outName);

const md = [];
md.push(`# Fingerprint Analysis: ${basename(instPath)}`);
md.push('');
md.push(`- analyzed: ${new Date().toISOString()}`);
md.push(`- total access log entries: ${flatLog.length}`);
md.push(`- issues found: ${issues.length}`);
md.push('');

md.push('## Persona');
md.push('');
md.push('| key | value |');
md.push('|---|---|');
for (const f of findings.filter(f => f.category === 'persona')) {
  md.push(`| ${f.message} | \`${String(f.value).slice(0, 120)}\` |`);
}
md.push('');

md.push('## Findings');
md.push('');
md.push('| category | message | value |');
md.push('|---|---|---|');
for (const f of findings.filter(f => f.category !== 'persona')) {
  md.push(`| ${f.category} | ${f.message} | \`${String(f.value).slice(0, 200)}\` |`);
}
md.push('');

md.push('## Issues');
md.push('');
for (const i of issues.sort((a, b) => {
  const sev = { critical: 0, high: 1, medium: 2, low: 3 };
  return sev[a.severity] - sev[b.severity];
})) {
  md.push(`### ${i.severity.toUpperCase()}: ${i.category}`);
  md.push('');
  md.push(i.message);
  md.push('');
  if (i.evidence) {
    md.push('```json');
    md.push(JSON.stringify(i.evidence, null, 2).slice(0, 800));
    md.push('```');
    md.push('');
  }
}

writeFileSync(outPath, md.join('\n'));
console.log(`Analysis written to: ${outPath}`);
console.log(`Issues found: ${issues.length} (${issues.filter(i => i.severity === 'critical').length} critical, ${issues.filter(i => i.severity === 'high').length} high)`);

for (const i of issues) {
  console.log(`[${i.severity.toUpperCase()}] ${i.category}: ${i.message}`);
}
