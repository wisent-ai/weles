import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT_DIR = __dirname;

// Shared across browsers. automation.js = navigator.webdriver scrub;
// navigator.js = Navigator.prototype overrides (has its own Chrome-branching
// guards); webgl.js = vendor/renderer overrides.
const SHARED_SCRIPTS = ['automation.js', 'navigator.js', 'webgl.js'];
// Chromium-only. Injects window.Sanitizer + AnimationTrigger + TimelineTrigger*
// to fill the Chromium-145-vs-real-Chrome-147 API gap. MUST NOT load on
// Firefox — real Firefox does not expose these globals and the presence
// of them on a Firefox-UA session is a fatal classifier tell.
const CHROMIUM_ONLY_SCRIPTS = ['chrome147_stubs.js'];
// Firefox-only. Scrubs Playwright juggler markers and asserts Firefox-
// expected navigator surfaces.
const FIREFOX_ONLY_SCRIPTS = ['firefox/stubs.js'];

/**
 * Build a combined init script string that can be injected into a page
 * via Page.addScriptToEvaluateOnNewDocument.
 *
 * Prepends `const __weles = <config>;` and concatenates the JS files
 * appropriate for `config.browser`, skipping any listed in `exclude`.
 *
 * @param config  - Fingerprint configuration object exposed to scripts.
 *                  Reads `config.browser` to decide which stubs load.
 * @param exclude - Filenames to skip (e.g. ['webgl.js']).
 */
export function buildInitScript(
  config: Record<string, any>,
  exclude?: string[],
): string {
  const excludeSet = new Set(exclude ?? []);
  const browser = (config.browser ?? 'chromium') as string;

  const scripts = [...SHARED_SCRIPTS];
  if (browser === 'chromium') scripts.push(...CHROMIUM_ONLY_SCRIPTS);
  else scripts.push(...FIREFOX_ONLY_SCRIPTS);

  const parts: string[] = [`const __weles = ${JSON.stringify(config)};`];
  for (const name of scripts) {
    if (excludeSet.has(name)) continue;
    const filePath = join(SCRIPT_DIR, name);
    parts.push(readFileSync(filePath, 'utf-8'));
  }
  return parts.join('\n');
}
