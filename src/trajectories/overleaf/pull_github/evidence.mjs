// What the pull leaves behind when a step misses: a DOM dump, a hard failure with that
// dump, and the captured Overleaf auth cookies.
import { writeFileSync } from 'node:fs';
import { OVERLEAF_AUTH_LABEL, SHOT_DIR } from './settings.mjs';

let shotN = 0;
export async function shot(s, tag) {
  shotN += 1;
  // DOM dump, NOT page.screenshot. page.screenshot() hangs ~30s on the
  // Overleaf editor SPA: it waits for fonts/stability the editor never
  // reaches (continuous PDF compile + CodeMirror + websockets), observed
  // as a 30s timeout that aborts the run. page.content() serializes the
  // current DOM immediately without that wait, and is a *better*
  // diagnostic for locating the exact selector when a step misses.
  const p = `${SHOT_DIR}/${String(shotN).padStart(2, '0')}_${tag}.html`;
  const html = await s.page.content();
  writeFileSync(p, html);
  console.log(`[pull_github] [${tag}] DOM ${p} (${html.length}b)`);
  return p;
}
export function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
export async function dieUI(s, tag, msg) {
  console.error(`\n[pull_github] STEP FAILED: ${tag} — ${msg}`);
  const p = await shot(s, `fail_${tag}`);
  console.error(`[pull_github] FAIL (exit 2). Inspect ${p} to correct the exact selector — do not guess.`);
  await s.close();
  process.exit(2);
}
export async function captureOverleafAuth(store, s, why) {
  const cookies = await store.capturePlaywright(s.ctx, OVERLEAF_AUTH_LABEL);
  const overleafCookies = cookies.filter((c) => String(c.domain || '').includes('overleaf.com')).length;
  console.log(`[pull_github] captured ${overleafCookies}/${cookies.length} cookies for ${OVERLEAF_AUTH_LABEL} (${why})`);
}
