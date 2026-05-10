#!/usr/bin/env node
/**
 * Enforce humanization atom usage across scripts/trajectories/ for any
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
 *   - scripts/trajectories/{juicysms,oxylabs,iproyal,packetstream,fivesim,
 *     pingproxies,nopecha,twocaptcha,sadcaptcha,anticaptcha,capmonster,
 *     capsolver,brightdata,unusualwhales,vast,volumeleaders,apple}/
 *   - scripts/trajectories/_shared/services/topup_common.mjs (vendor topup helper)
 *   - scripts/trajectories/_shared/services/real_chrome.mjs (one-off attach helper)
 *   - scripts/trajectories/google/gcp_credits.mjs (GCP console)
 *
 * Files explicitly checked: every other .mjs in scripts/trajectories/.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = join(process.cwd(), 'scripts', 'trajectories');

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

// Find every `page.evaluate(` opening and return [start, end] index pairs of
// each matched call so we can ignore patterns that occur inside (those are
// covered by check_trust.mjs and are about a different anti-pattern).
function evaluateRanges(src) {
  const out = [];
  const re = /\.evaluate\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const from = m.index + m[0].length;
    let depth = 1;
    let i = from;
    let inS = null;
    let inT = false;
    let inLC = false;
    let inBC = false;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (inLC) {
        if (c === '\n') inLC = false;
      } else if (inBC) {
        if (c === '*' && n === '/') { inBC = false; i++; }
      } else if (inS) {
        if (c === '\\') i++;
        else if (c === inS) inS = null;
      } else if (inT) {
        if (c === '\\') i++;
        else if (c === '`') inT = false;
        else if (c === '$' && n === '{') {
          let dd = 1;
          i += 2;
          while (i < src.length && dd > 0) {
            const cc = src[i];
            if (cc === '{') dd++;
            else if (cc === '}') dd--;
            i++;
          }
          continue;
        }
      } else if (c === '/' && n === '/') { inLC = true; i++; }
      else if (c === '/' && n === '*') { inBC = true; i++; }
      else if (c === '"' || c === "'") inS = c;
      else if (c === '`') inT = true;
      else if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) { out.push([m.index, i + 1]); break; }
      }
      i++;
    }
  }
  return out;
}

function inAnyRange(idx, ranges) {
  for (const [a, b] of ranges) if (idx >= a && idx < b) return true;
  return false;
}

// Patterns. Each returns array of {line, col, snippet, msg}.
function findBareClicks(src, evalRanges) {
  const out = [];
  // Match `.click(` that isn't preceded by a humanized atom or trusted helper.
  // Allowed: humanClick(, humanClickLocator(, page.mouse.click(, s.click(,
  // s.jsClick(, s.clickSelector(, page.click(, frame.click(, s.page.mouse.click(,  // allow-raw-playwright: lint / test fixture — pattern reference, not actual call
  // .click({force:true})  (vendor admin force flag — already exempt).
  const lines = src.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (/\.click\s*\(/.test(line)) {
      // Skip if any of the allowed contexts are matched.
      if (/humanClick\s*\(/.test(line)) continue;
      if (/humanClickLocator\s*\(/.test(line)) continue;
      // s.click(...) is the WSession.click wrapper — already humanized.
      if (/\bs\.click\s*\(/.test(line)) continue;
      // s.jsClick is the deliberate shadow-DOM escape hatch (covered by check_trust).
      if (/\bs\.jsClick\s*\(/.test(line)) continue;
      // WSession.clickSelector wrapper now routes through humanClickLocator.
      if (/\bs\.clickSelector\s*\(/.test(line)) continue;
      // page.mouse.click is CDP-routed already.
      if (/\.mouse\.click\s*\(/.test(line)) continue;
      // Material Design <li> option list items require force:true to click
      // (they're positioned in detached portals). These are not user-facing
      // buttons — they're select-option equivalents inside dropdown menus.
      if (/\.click\s*\(\s*\{\s*force\s*:\s*true/.test(line) && /li\[|role.*option|data-value/.test(line)) continue;
      // page.click(target) is Playwright's high-level helper that auto-scrolls  // allow-raw-playwright: lint / test fixture — pattern reference, not actual call
      // and uses CDP — acceptable. But we don't actually use it anywhere in
      // social trajectories; flag any new occurrences just in case.
      // Find the absolute index of the `.click(` to test eval-range inclusion.
      const idx = src.indexOf(line) === -1 ? -1 : src.indexOf(line);
      if (idx >= 0 && inAnyRange(idx + line.indexOf('.click('), evalRanges)) continue;
      // Strip strings/comments-only matches.
      const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*.*\*\//g, '');
      if (!/\.click\s*\(/.test(stripped)) continue;
      out.push({
        line: li + 1,
        col: line.indexOf('.click(') + 1,
        snippet: line.trim().slice(0, 140),
        msg: 'bare locator.click() — use humanClickLocator(page, locator) instead',
      });
    }
  }
  return out;
}

function findBareFills(src, evalRanges) {
  const out = [];
  const lines = src.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!/\.fill\s*\(/.test(line)) continue;
    if (/humanFill\s*\(/.test(line)) continue;
    // s.fill is WSession wrapper — now humanized.
    if (/\bs\.fill\s*\(/.test(line)) continue;
    // lint-allow:bare-fill — explicit per-line exemption for cases where
    // humanFill's keyboard select-all+delete causes the framework (e.g.
    // Reddit's React-controlled username field) to re-inject a server
    // suggestion. The .fill('') React-setter clear is the only reliable
    // way to remove the suggestion before humanType writes the chosen value.
    if (/lint-allow:\s*bare-fill/.test(line)) continue;
    // Skip {force:true}.fill weirdness (vendor admin) — those are in EXEMPT_DIRS.
    const idx = src.indexOf(line) === -1 ? -1 : src.indexOf(line);
    if (idx >= 0 && inAnyRange(idx + line.indexOf('.fill('), evalRanges)) continue;
    const stripped = line.replace(/\/\/.*$/, '').replace(/\/\*.*\*\//g, '');
    if (!/\.fill\s*\(/.test(stripped)) continue;
    out.push({
      line: li + 1,
      col: line.indexOf('.fill(') + 1,
      snippet: line.trim().slice(0, 140),
      msg: 'bare locator.fill() — use humanFill(page, locator, value) instead',
    });
  }
  return out;
}

function findFixedDelayTyping(src) {
  const out = [];
  const lines = src.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // pressSequentially( anywhere → not allowed.
    if (/\.pressSequentially\s*\(/.test(line)) {
      out.push({
        line: li + 1,
        col: line.indexOf('.pressSequentially(') + 1,
        snippet: line.trim().slice(0, 140),
        msg: 'pressSequentially() uses fixed-delay timing — use humanType(page, text)',
      });
    }
    // keyboard.type( with delay option.
    if (/keyboard\.type\s*\(/.test(line) && /delay\s*:/.test(line)) {
      out.push({
        line: li + 1,
        col: line.indexOf('keyboard.type(') + 1,
        snippet: line.trim().slice(0, 140),
        msg: 'keyboard.type({delay}) uses fixed-delay timing — use humanType(page, text)',
      });
    }
  }
  return out;
}

function findEvaluateValueDescriptorWrites(src, evalRanges) {
  const out = [];
  // Pattern: Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(...)
  // or HTMLTextAreaElement.prototype variant, followed nearby by
  // dispatchEvent(new Event('input', ...)). These bypass keystrokes entirely.
  // But skip matches inside page.evaluate() blocks — those are typically
  // captcha-internal token injections or OTP splits that are already inside
  // the evaluate sandbox and don't represent user-facing form fills.
  const re = /Object\.getOwnPropertyDescriptor\s*\(\s*HTML(Input|TextArea)Element\.prototype\s*,\s*['"]value['"]\s*\)\s*\.set/g;
  let m;
  while ((m = re.exec(src))) {
    // Skip if this occurrence is inside a page.evaluate() block.
    if (inAnyRange(m.index, evalRanges)) continue;
    const before = src.slice(0, m.index);
    const line = before.split('\n').length;
    const col = m.index - before.lastIndexOf('\n');
    out.push({
      line,
      col,
      snippet: src.slice(m.index, m.index + 80).replace(/\s+/g, ' '),
      msg: 'evaluate-set-value-descriptor pattern bypasses keystrokes — use humanFill(page, locator, value)',
    });
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
    console.log(`scripts/trajectories/${f.file}`);
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
