#!/usr/bin/env node
/**
 * Guardrail: task-facing browser work must go through Weles, not ad-hoc local
 * Playwright launches. Weles infrastructure may launch browsers in the small,
 * reviewed allowlist below; everything else should dispatch through WSession /
 * AsyncNewBrowser / the worker queue so binary, session, recording, proxy, and
 * device policy are applied consistently.
 *
 * This is a static source guard. It cannot intercept code typed into an eval
 * cell; that requires a harness/tool-level runtime guard.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const targets = process.argv.slice(2).map((p) => resolve(p));
const scanRoots = targets.length ? targets : [join(ROOT, 'src'), join(ROOT, 'tests')];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'recordings', '.work', 'coverage']);
const EXTENSIONS = new Set(['.mjs', '.js', '.cjs', '.ts', '.tsx']);

const PLAYWRIGHT_IMPORT_RE = /(?:from\s+['"]playwright(?:\/[^'"]*)?['"]|require\(\s*['"]playwright(?:\/[^'"]*)?['"]\s*\)|from\s+['"]playwright\.async_api['"])/;
const DIRECT_BROWSER_LAUNCH_RE = /(?:\b[A-Za-z_$][\w$]*\.launch(?:PersistentContext)?\s*\(|\basync_playwright\s*\()/;
const ALLOWLIST = new Map([
  ['src/async_api.ts', 'Weles AsyncNewBrowser factory; this is the sanctioned Playwright boundary.'],
  ['src/browser/firefox_launch.ts', 'Weles Firefox launcher; this is infrastructure, not a task script.'],
  ['src/browser/real_chrome.mjs', 'Weles real-Chrome launcher: the one place a genuine Chrome is started, for provider flows the patched Chromium cannot complete. Trajectories call it; they never launch Playwright themselves.'],
  ['src/keeper/keeper.mjs', 'Keeper owns the persistent session it serves over its own socket; the documented discovery surface is infrastructure, not a task script.'],
  ['tests/firefox/launch-without-recording.test.mjs', 'The raw launch is the subject of this test: it narrows whether recordVideo is what closes the context on VMAPPLE.'],
]);

function allowReason(file) {
  const rel = relative(ROOT, file);
  return ALLOWLIST.get(rel) ?? null;
}

function extname(path) {
  const idx = path.lastIndexOf('.');
  return idx >= 0 ? path.slice(idx) : '';
}

function walk(path, out = []) {
  let st;
  try {
    st = statSync(path);
  } catch {
    return out;
  }
  if (st.isDirectory()) {
    const name = path.split('/').pop();
    if (SKIP_DIRS.has(name)) return out;
    for (const ent of readdirSync(path)) walk(join(path, ent), out);
  } else if (st.isFile() && EXTENSIONS.has(extname(path))) {
    out.push(path);
  }
  return out;
}

const files = scanRoots.flatMap((p) => walk(p)).sort();
const hits = [];
for (const file of files) {
  const reason = allowReason(file);
  if (reason) continue;
  const src = readFileSync(file, 'utf8');
  const hasPlaywrightImport = PLAYWRIGHT_IMPORT_RE.test(src);
  const launch = DIRECT_BROWSER_LAUNCH_RE.exec(src);
  if (!hasPlaywrightImport || !launch) continue;
  const rel = relative(ROOT, file);
  const line = src.slice(0, launch.index).split('\n').length;
  hits.push({ file: rel, line });
}

if (!hits.length) {
  console.log(`[lint-browser-boundary] OK — scanned ${files.length} files, no direct local Playwright browser launches outside Weles infrastructure`);
  process.exit(0);
}

console.log(`[lint-browser-boundary] FAIL — ${hits.length} direct local Playwright browser launch(es) outside Weles infrastructure:\n`);
for (const hit of hits) {
  console.log(`  ${hit.file}:${hit.line}`);
}
console.log('\nBrowser tasks must run through Weles on the host selected by the Stado service registry. Do not launch local Playwright/Chrome directly.');
console.log('Approved boundary: stado service resolve com.wisent.always-on.weles --json -> selected host -> WSession / AsyncNewBrowser / worker queue.');
console.log('Allowed local infrastructure launch points:');
for (const [file, reason] of ALLOWLIST) console.log(`  ${file} — ${reason}`);
console.log('This static lint cannot block ad-hoc eval cells; install a runtime guard that enforces the same registry-selected Weles API policy.');
process.exit(1);
