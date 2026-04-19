import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT_DIR = __dirname;

const DEFAULT_SCRIPTS = ['automation.js', 'navigator.js', 'webgl.js', 'chrome147_stubs.js'];

/**
 * Build a combined init script string that can be injected into a page
 * via Page.addScriptToEvaluateOnNewDocument.
 *
 * Prepends `const __weles = <config>;` and concatenates the JS files
 * from the scripts directory, skipping any listed in `exclude`.
 *
 * @param config  - Fingerprint configuration object exposed to scripts.
 * @param exclude - Filenames to skip (e.g. ['webgl.js']).
 * @returns Combined JavaScript source string.
 */
export function buildInitScript(
  config: Record<string, any>,
  exclude?: string[],
): string {
  const excludeSet = new Set(exclude ?? []);

  const parts: string[] = [
    `const __weles = ${JSON.stringify(config)};`,
  ];

  for (const name of DEFAULT_SCRIPTS) {
    if (excludeSet.has(name)) continue;
    const filePath = join(SCRIPT_DIR, name);
    parts.push(readFileSync(filePath, 'utf-8'));
  }

  return parts.join('\n');
}
