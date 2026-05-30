#!/usr/bin/env node
// Reduce every existing keeper instrument capture in .work/inst/ to one row of
// matrix.jsonl, classified by (browser, os, initial URL, outcome). Pairs with
// fp_matrix/diff.mjs which reads matrix.jsonl and computes consistent deltas
// across PASS vs FAIL captures.
//
// Outcome is derived from the capture's Fetch.POST URL sequence, NOT from any
// human-written memory file:
//   - GAUNTLET: a Fetch.POST to https://www.google.com/recaptcha/enterprise/clr
//     (the reCAPTCHA Enterprise modal endpoint) is present
//   - PHONE_VERIFY: createAccount was followed by /signup/api/sendPin or
//     /checkpoint/challenge/verify
//   - PASS: capture ends on /feed, /home, or /in/ (signed in)
//   - CREATEACCOUNT_NO_GAUNTLET: createAccount succeeded without modal
//   - UNKNOWN: none of the above markers
//
// Persona (browser+os) and initial URL come from .work/keeper_<label>.log
// which the keeper writes at start.

import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES_ROOT = join(__dirname, '..', '..', '..');
const INST_DIR = join(WELES_ROOT, '.work', 'inst');
const WORK_DIR = join(WELES_ROOT, '.work');
const OUT_PATH = join(INST_DIR, 'matrix.jsonl');

const captures = readdirSync(INST_DIR)
  .filter(f => f.startsWith('keeper-') && f.endsWith('.json'))
  .map(f => ({ f, full: join(INST_DIR, f), mtime: statSync(join(INST_DIR, f)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);

console.log(`scanning ${captures.length} keeper instrument captures`);

const rows = [];
for (const cap of captures) {
  const m = cap.f.match(/^keeper-(.+?)_(\d{4}-\d{2}-\d{2}T[\d-]+Z)\.json$/);
  if (!m) { console.log(`SKIP ${cap.f} (bad name)`); continue; }
  const label = m[1];
  const captureIso = m[2];

  const logPath = join(WORK_DIR, `keeper_${label}.log`);
  let browser = null, os = null, initialUrl = null;
  if (existsSync(logPath)) {
    const log = readFileSync(logPath, 'utf-8');
    const pm = log.match(/\[persona\]\s+os=(\S+)\s+browser=(\S+)/);
    if (pm) { os = pm[1]; browser = pm[2]; }
    const um = log.match(/\[keeper:[^\]]+\]\s+at\s+(\S+)/);
    if (um) initialUrl = um[1];
  }

  let j;
  try { j = JSON.parse(readFileSync(cap.full, 'utf-8')); }
  catch (e) { console.log(`SKIP ${cap.f} (json parse)`); continue; }

  const surfaceKeys = new Set();
  const fetchPosts = [];
  const xhrUrls = [];
  let lastFrameUrl = null;
  for (const frame of (j.accesses ?? [])) {
    if (frame.url) lastFrameUrl = frame.url;
    if (!Array.isArray(frame.log)) continue;
    for (const e of frame.log) {
      if (e.o === 'Fetch' && typeof e.p === 'string' && e.p.startsWith('POST:')) {
        fetchPosts.push(e.p.slice('POST:'.length));
      }
      if (e.o === 'XHR' && typeof e.p === 'string' && e.p.startsWith('open:')) {
        xhrUrls.push(e.vs ?? '');
      }
      if (typeof e.o === 'string' && typeof e.p === 'string') {
        // Property-access key: object.property. Strip trailing args/values
        // from method calls so e.g. getEntriesByType:resource doesn't blow
        // up the key space.
        const propBase = e.p.split(':')[0];
        surfaceKeys.add(e.o + '.' + propBase);
      }
    }
  }

  const hasRecaptchaEnterprise = fetchPosts.some(u => u.includes('recaptcha/enterprise/clr'));
  const hasPhoneVerifyPin = fetchPosts.some(u => /\/signup\/api\/sendPin|checkpoint\/challenge\/verify/.test(u))
                          || xhrUrls.some(u => /\/signup\/api\/sendPin|checkpoint\/challenge\/verify/.test(u));
  const passUrlMarker = /linkedin\.com\/(feed|home|in\/)/.test(lastFrameUrl ?? '');
  const hadCreateAccount = fetchPosts.some(u => /\/signup\/api\/cors\/createAccount/.test(u))
                         || xhrUrls.some(u => /\/signup\/api\/cors\/createAccount/.test(u));

  // Final-state URL wins over mid-flow markers: a session that hit reCAPTCHA
  // but ended on /onboarding/ or /feed actually succeeded (captcha solved).
  const onboardingUrlMarker = /linkedin\.com\/(onboarding|checkpoint\/landing|home-page|search\/results)/.test(lastFrameUrl ?? '');
  const stuckOnRecaptchaUrl = /^https?:\/\/www\.google\.com\/recaptcha\//.test(lastFrameUrl ?? '');

  let outcome = 'UNKNOWN';
  if (passUrlMarker || onboardingUrlMarker) outcome = 'ULTIMATE_PASS';
  else if (hasRecaptchaEnterprise && stuckOnRecaptchaUrl) outcome = 'GAUNTLET_STUCK';
  else if (hasRecaptchaEnterprise) outcome = 'GAUNTLET_OTHER';
  else if (hasPhoneVerifyPin) outcome = 'PHONE_VERIFY';
  else if (hadCreateAccount) outcome = 'CREATEACCOUNT_NO_GAUNTLET';

  rows.push({
    label, captureIso, mtime: cap.mtime, file: cap.f,
    browser, os, initialUrl, lastFrameUrl,
    outcome, hasRecaptchaEnterprise, hasPhoneVerifyPin, hadCreateAccount,
    surfaceKeys: [...surfaceKeys].sort(),
    surfaceKeyCount: surfaceKeys.size,
    fetchPostCount: fetchPosts.length,
  });
}

writeFileSync(OUT_PATH, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
console.log(`wrote ${rows.length} rows -> ${OUT_PATH}`);

const groups = {};
for (const r of rows) {
  const key = `${r.browser ?? '?'}/${r.os ?? '?'} | ${r.outcome}`;
  groups[key] = (groups[key] ?? 0) + 1;
}
console.log('');
console.log('count by (browser/os | outcome):');
for (const [k, n] of Object.entries(groups).sort()) {
  console.log(`  ${n.toString().padStart(3)}  ${k}`);
}
