#!/usr/bin/env node
/**
 * Enforce humanization atom usage across src/trajectories/ for any
 * trajectory that touches a *social-platform account session*. We discovered
 * 2026-04-29 that a fresh Reddit account got hard-banned within minutes of
 * its first comment because reddit_comment.mjs was still using a synthetic
 * `evaluate(() => btn.click())` for the submit button — bypassing the entire
 * humanization stack we'd built. Audit then turned up the same class of
 * bypass across nearly every register/login/action trajectory: bare
 * `locator.click()` (no real mouse trajectory), `locator.fill(v)` (no
 * keystrokes at all), `pressSequentially({delay})` (fixed-delay timing),
 * `page.evaluate(set descriptor + dispatch input event)` (zero key events),
 * etc.
 *
 * The atoms — `humanClick`, `humanClickLocator`, `humanType`, `humanFill` —
 * route every interaction through CDP with isTrusted=true, real Bezier mouse
 * paths, and empirical-trace-derived dwell + inter-keystroke timing. They
 * exist for a reason. This lint makes sure new code uses them.
 *
 * Patterns flagged:
 *   1. Bare `<locator-or-element>.click()` outside humanClickLocator/humanClick
 *      and outside `page.evaluate(...)` (which is already covered by
 *      check_trust.mjs).
 *   2. Bare `<locator-or-element>.fill(...)` outside humanFill.
 *   3. `pressSequentially(` and `keyboard.type(` with a `delay` option — fixed
 *      delays are the hallmark of legacy automation; humanType samples per-
 *      character from the trace distribution.
 *   4. `page.evaluate(...)` blocks that set input.value via the property
 *      descriptor and dispatch an 'input' or 'change' event — bypasses every
 *      keystroke (the LinkedIn / GitHub anti-pattern).
 *
 * Files exempted (these are vendor admin sites, NOT social-platform accounts;
 * humanization here doesn't affect ban risk for the platform-side accounts we
 * actually care about):
 *   - src/trajectories/{juicysms,oxylabs,iproyal,packetstream,fivesim,
 *     pingproxies,nopecha,twocaptcha,sadcaptcha,anticaptcha,capmonster,
 *     capsolver,brightdata,unusualwhales,vast,volumeleaders,apple}/
 *   - src/trajectories/_shared/services/topup_common.mjs (vendor topup helper)
 *   - src/trajectories/_shared/services/real_chrome.mjs (one-off attach helper)
 *   - src/trajectories/google/gcp_credits.mjs (GCP console)
 *
 * Files explicitly checked: every other .mjs in src/trajectories/.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  evaluateRanges,
  findBareClicks,
  findBareFills,
  findEvaluateValueDescriptorWrites,
  findFixedDelayTyping,
} from './humanization/patterns.mjs';

const ROOT = join(process.cwd(), 'src', 'trajectories');

const EXEMPT_DIRS = [
  'juicysms',
  'oxylabs',
  'iproyal',
  'packetstream',
  'fivesim',
  'pingproxies',
  'nopecha',
  'twocaptcha',
  'sadcaptcha',
  'anticaptcha',
  'capmonster',
  'capsolver',
  'brightdata',
  'unusualwhales',
  'vast',
  'volumeleaders',
  'apple',
];

const EXEMPT_FILES = [
  '_shared/services/topup_common.mjs',
  '_shared/services/real_chrome.mjs',
  'google/gcp_credits.mjs',
  // The fingerprint diagnostic; needs raw API access intentionally.
  '../diag/fingerprint_audit.mjs',
  // Captcha solvers operate inside Arkose/hCaptcha frames — not account-facing.
  'github/_audio_solver.mjs',
  'github/_coords_solver.mjs',
  'github/_funcaptcha.mjs',
];

function isExempt(rel) {
  for (const dir of EXEMPT_DIRS) if (rel.startsWith(`${dir}/`)) return true;
  for (const f of EXEMPT_FILES) if (rel === f) return true;
  return false;
}

async function walk(dir) {
  const out = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...(await walk(p)));
    else if (ent.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

(async () => {
  const files = await walk(ROOT);
  let total = 0;
  const failures = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    if (isExempt(rel)) continue;
    const src = await readFile(file, 'utf8');
    const evalRanges = evaluateRanges(src);
    const issues = [
      ...findBareClicks(src, evalRanges),
      ...findBareFills(src, evalRanges),
      ...findFixedDelayTyping(src),
      ...findEvaluateValueDescriptorWrites(src, evalRanges),
    ];
    if (issues.length) {
      total += issues.length;
      failures.push({ file: rel, issues });
    }
  }
  if (!failures.length) {
    console.log(`OK: humanization atoms used everywhere (${files.length} files scanned)`);
    process.exit(0);
  }
  console.log(`FAIL: ${total} humanization-bypass(es) found across ${failures.length} file(s)\n`);
  for (const f of failures) {
    console.log(`src/trajectories/${f.file}`);
    for (const i of f.issues) {
      console.log(`  ${i.line}:${i.col}  ${i.msg}`);
      console.log(`         ${i.snippet}`);
    }
    console.log('');
  }
  console.log('Use humanClickLocator(page, locator) for clicks, humanFill(page, locator, text) for inputs,');
  console.log('and humanType(page, text) for free-form keyboard typing. WSession.click/fill/clickSelector');
  console.log('already route through these atoms; calling them directly is the right pattern for trajectories.');
  process.exit(1);
})();
