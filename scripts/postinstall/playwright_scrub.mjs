// Idempotent postinstall scrub of Playwright-specific identifier names in
// node_modules/playwright-core/lib/generated/injectedScriptSource.js so bot
// classifiers cannot key off them via EventTarget.addEventListener or the
// global-listeners re-detection loop. Replaces:
//   __playwright_global_listeners_check__ -> __wpc_glc_fb3e7a__
//   __playwright_mark_target__            -> __wpc_mt_fb3e7a__
//   __playwright_unmark_target__          -> __wpc_ut_fb3e7a__
// and deletes the `this._setupGlobalListenersRemovalDetection();` call site
// that re-arms the leak on each navigation. Preserves a one-shot .bak the
// first time it runs; after that the scrub is a no-op.
//
// Wired from package.json `postinstall` so the scrub survives npm install /
// npm ci (node_modules is gitignored). Benefits both Chromium and Firefox
// paths — the file is shared across Playwright browser bindings.

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TARGET = resolve('node_modules/playwright-core/lib/generated/injectedScriptSource.js');

if (!existsSync(TARGET)) { console.log(`[pw-scrub] skip (no playwright-core at ${TARGET})`); process.exit(0); }

const original = readFileSync(TARGET, 'utf-8');
const replacements = [
  ['__playwright_global_listeners_check__', '__wpc_glc_fb3e7a__'],
  ['__playwright_mark_target__',            '__wpc_mt_fb3e7a__'],
  ['__playwright_unmark_target__',          '__wpc_ut_fb3e7a__'],
];
let out = original;
for (const [from, to] of replacements) out = out.split(from).join(to);
out = out.replace(/this\._setupGlobalListenersRemovalDetection\(\);/g, '/*removed*/');

if (out === original) { console.log('[pw-scrub] already scrubbed (no-op)'); process.exit(0); }

if (!existsSync(TARGET + '.bak')) copyFileSync(TARGET, TARGET + '.bak');
writeFileSync(TARGET, out);
console.log(`[pw-scrub] renamed ${replacements.length} identifiers and removed _setupGlobalListenersRemovalDetection call in ${TARGET}`);
