#!/usr/bin/env node
// One-command wrapper for the trajectory <-> human diff harness.
//
// Usage:
//   node scripts/debug/diff_trajectory.mjs scripts/trajectories/tiktok_login.mjs
//
// What it does (in order):
//   1. Derives PLATFORM from the trajectory path (e.g. tiktok_login -> tiktok).
//   2. Derives TARGET_URL by grep-ing the trajectory for the first URL that
//      starts with "https://" inside a goto() / WSession.start(). Override
//      with TARGET_URL=... env if the auto-pick is wrong.
//   3. Looks for a fresh chrome reference at
//      .work/inst/chrome_<platform>_*.json (newest, < CHROME_REFERENCE_TTL_HRS,
//      default 72h). If missing, prints the exact instrument_chrome.mjs
//      invocation and EXITS — fixes are blocked until you capture one. Set
//      ALLOW_STALE_CHROME=1 to use any chrome dump regardless of age.
//   4. Runs the trajectory with WELES_INSTRUMENT=1 (passes through the rest
//      of the env). Skip the run with SKIP_RUN=1 if you already have a recent
//      weles dump.
//   5. Picks the newest weles dump matching .work/inst/<label>_*.json.
//   6. Runs instrument_diff and captures stdout to a markdown report at
//      .work/inst/<label>_diff_<ts>.md.
//   7. Prints the report path. The report is the only acceptable input to a
//      fix proposal per CLAUDE.md.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WELES_ROOT = join(__dirname, '..', '..');
const INST_DIR = join(WELES_ROOT, '.work', 'inst');
mkdirSync(INST_DIR, { recursive: true });

const TRAJECTORY_REL = process.argv[2];
if (!TRAJECTORY_REL) {
  console.error('usage: node scripts/debug/diff_trajectory.mjs <trajectory_path.mjs>');
  console.error('  e.g. node scripts/debug/diff_trajectory.mjs scripts/trajectories/tiktok_login.mjs');
  process.exit(2);
}
const TRAJECTORY = TRAJECTORY_REL.startsWith('/') ? TRAJECTORY_REL : join(WELES_ROOT, TRAJECTORY_REL);
if (!existsSync(TRAJECTORY)) {
  console.error(`trajectory not found: ${TRAJECTORY}`);
  process.exit(2);
}

const TRAJ_NAME = basename(TRAJECTORY).replace(/\.mjs$/, '');

// Step 1: derive PLATFORM. Convention: <platform>_<verb>.mjs OR <platform>/<verb>.mjs.
let platform = process.env.PLATFORM || '';
if (!platform) {
  const parts = TRAJECTORY.split('/');
  const trajIdx = parts.indexOf('trajectories');
  if (trajIdx >= 0 && parts.length > trajIdx + 2) platform = parts[trajIdx + 1];
  else platform = TRAJ_NAME.split('_')[0];
}
if (!platform) {
  console.error('could not derive PLATFORM. Set PLATFORM=<name> env.');
  process.exit(2);
}

// Step 2: derive TARGET_URL. First scan trajectory file for the first https
// literal that looks like a navigation target (goto, FEED_URL/PASSWORD_URL/etc.).
let targetUrl = process.env.TARGET_URL || '';
if (!targetUrl) {
  const src = readFileSync(TRAJECTORY, 'utf-8');
  const candidates = [];
  // 1) const X_URL = 'https://...'
  for (const m of src.matchAll(/const\s+\w*URL\w*\s*=\s*['"`](https:\/\/[^'"`\s]+)['"`]/g)) candidates.push(m[1]);
  // 2) goto('https://...') or s.goto('https://...')
  for (const m of src.matchAll(/\.goto\(\s*['"`](https:\/\/[^'"`\s]+)['"`]/g)) candidates.push(m[1]);
  // First non-static-asset URL wins.
  targetUrl = candidates.find((u) => !/\.(js|css|png|jpg|svg|ico)$/.test(u)) || candidates[0] || '';
}
if (!targetUrl) {
  console.error(`could not derive TARGET_URL from ${TRAJECTORY}. Set TARGET_URL=... env.`);
  process.exit(2);
}

console.log(`[diff_trajectory] trajectory=${TRAJ_NAME} platform=${platform} target=${targetUrl}`);

// Step 3: locate fresh chrome reference.
const TTL_HRS = Number(process.env.CHROME_REFERENCE_TTL_HRS || 72);
const allowStale = process.env.ALLOW_STALE_CHROME === '1';
const chromeFiles = readdirSync(INST_DIR)
  .filter((f) => f.startsWith(`chrome_${platform}_`) && f.endsWith('.json'))
  .map((f) => ({ f, full: join(INST_DIR, f), m: statSync(join(INST_DIR, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
const newestChrome = chromeFiles[0];
const ageHrs = newestChrome ? (Date.now() - newestChrome.m) / 3_600_000 : Infinity;
if (!newestChrome || (!allowStale && ageHrs > TTL_HRS)) {
  console.error('');
  console.error(`BLOCKED: no chrome reference for platform=${platform} within ${TTL_HRS}h.`);
  console.error('');
  console.error('Capture one now (real Chrome, you drive the flow by hand):');
  console.error('');
  console.error(`  PLATFORM=${platform} TARGET_URL='${targetUrl}' \\`);
  console.error(`    node scripts/debug/instrument_chrome.mjs`);
  console.error('');
  console.error('Drive the flow to completion (login, captcha, whatever the trajectory does).');
  console.error('Ctrl+C in terminal or close the browser to finalize.');
  console.error('Then re-run this command.');
  console.error('');
  console.error('To use an older reference anyway: ALLOW_STALE_CHROME=1');
  process.exit(3);
}
console.log(`[diff_trajectory] chrome reference: ${newestChrome.f} (${ageHrs.toFixed(1)}h old)`);

// Step 4: run the trajectory with WELES_INSTRUMENT=1 (unless SKIP_RUN=1).
let welesFile = null;
if (process.env.SKIP_RUN === '1') {
  console.log('[diff_trajectory] SKIP_RUN=1 — using newest existing weles dump');
} else {
  console.log(`[diff_trajectory] running trajectory with WELES_INSTRUMENT=1 ...`);
  const exitCode = await new Promise((resolve) => {
    const child = spawn('node', [TRAJECTORY], {
      env: { ...process.env, WELES_INSTRUMENT: '1' },
      cwd: WELES_ROOT,
      stdio: 'inherit',
    });
    child.on('close', (c) => resolve(c ?? -1));
  });
  console.log(`[diff_trajectory] trajectory exited with code=${exitCode}`);
}

// Step 5: pick newest weles dump for this label. WSession label conventionally
// matches the trajectory name; some trajectories use a different label so
// also fall back to ANY recent dump if exact match misses.
const allWelesFiles = readdirSync(INST_DIR)
  .filter((f) => f.endsWith('.json') && !f.startsWith('chrome_'))
  .map((f) => ({ f, full: join(INST_DIR, f), m: statSync(join(INST_DIR, f)).mtimeMs }))
  .sort((a, b) => b.m - a.m);
welesFile = allWelesFiles.find((x) => x.f.startsWith(`${TRAJ_NAME}_`)) || allWelesFiles[0];
if (!welesFile) {
  console.error('no weles dump found in .work/inst — did the trajectory run with WELES_INSTRUMENT=1?');
  process.exit(4);
}
console.log(`[diff_trajectory] weles dump: ${welesFile.f}`);

// Step 6: run instrument_diff and capture output.
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = join(INST_DIR, `${TRAJ_NAME}_diff_${ts}.md`);
const diffStdout = await new Promise((resolve, reject) => {
  const child = spawn('node', [
    join(__dirname, 'instrument_diff.mjs'),
    newestChrome.full,
    welesFile.full,
  ], { cwd: WELES_ROOT });
  let buf = '';
  child.stdout.on('data', (d) => { const s = d.toString(); buf += s; process.stdout.write(s); });
  child.stderr.on('data', (d) => process.stderr.write(d));
  child.on('close', (c) => c === 0 ? resolve(buf) : reject(new Error(`instrument_diff exited ${c}`)));
});

const report = `# Trajectory diff report

- trajectory: \`${TRAJECTORY_REL}\`
- platform: \`${platform}\`
- target URL: \`${targetUrl}\`
- chrome reference: \`${newestChrome.f}\` (${ageHrs.toFixed(1)}h old)
- weles dump: \`${welesFile.f}\`
- generated: ${new Date().toISOString()}

## Diff output

\`\`\`
${diffStdout.trim()}
\`\`\`

## How to use this report

The diff above is the ONLY acceptable input to a fix proposal per CLAUDE.md.
Pick a specific delta (a property the page accesses on chrome but never on
weles, an XHR URL only one side hits, an event listener type only one side
subscribes to, a SubtleCrypto encrypt count mismatch) and cite it as the
justification for any code change.

Mock/bypass-style fixes (faking an API response, stripping a header,
intercepting a route) are forbidden until you can point at the diff entry
that justifies them.
`;
writeFileSync(reportPath, report);
console.log('');
console.log(`[diff_trajectory] report written -> ${reportPath}`);
