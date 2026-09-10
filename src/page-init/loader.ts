import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FingerprintConfig } from '../fingerprint.js';

const SCRIPT_DIR = __dirname;

// Shared across browsers. automation.js = navigator.webdriver scrub;
// navigator/core.js = Navigator.prototype overrides (has its own Chrome-branching
// guards); webgl.js = vendor/renderer overrides.
const SHARED_SCRIPTS = ['automation.js', 'navigator/core.js', 'navigator/environment.js', 'navigator/surface.js', 'webgl.js'];
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
    parts.push(readPageInitScript(name));
  }
  return parts.join('\n');
}

/** Read source and packaged assets from the same page-init directory. */
export function readPageInitScript(name: string): string {
  return readFileSync(join(SCRIPT_DIR, 'page', name), 'utf-8');
}

/** C++ Chromium needs these supplements, not the stock automation overrides. */
export function buildChromiumSupplementScripts(fpConfig: FingerprintConfig): string[] {
  const screenPreamble = `const __weles = { screen: ${JSON.stringify(fpConfig.screen ?? {})} };`;
  const screenPatch = screenPreamble + '\n' + readPageInitScript('screen_webrtc_patch.js');
  const navPreamble = `const __weles = ${JSON.stringify(fpConfig)};` +
    `if (typeof _nativeOverrides === 'undefined') { var _nativeOverrides = new Set(); }` +
    `if (!window.__welesDefine) { window.__welesDefine = function(obj, prop, getter) { try { Object.defineProperty(obj, prop, { get: getter, configurable: true, enumerable: true }); } catch {} }; };` +
    `if (!window.__welesNativeString) { const _ns=new Set(); window.__welesNativeString=function(fn,name){_ns.add(fn);}; const _ots=Function.prototype.toString; Function.prototype.toString=function(){ if(_ns.has(this)) return 'function '+(this.name||'')+'() { [native code] }'; return _ots.call(this); }; }`;
  const navScript = navPreamble + '\n' + readPageInitScript('navigator/core.js') + '\n' + readPageInitScript('navigator/environment.js') + '\n' + readPageInitScript('navigator/surface.js');
  return [...CHROMIUM_ONLY_SCRIPTS.map(readPageInitScript), screenPatch, navScript];
}
