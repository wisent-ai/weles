// The environment the version-history probe runs with: the project and the phrase to find,
// the DOM dumps and summary beside the run's recordings, the recording switches this
// trajectory turns off, and the persistent Overleaf browser profile.
import { mkdirSync } from 'node:fs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';


export const target = process.argv[2] || process.env.OVERLEAF_PROJECT ||
  'Classifier Decision Boundaries Yield Stronger Steering Vectors';
export const queryText = process.argv.slice(3).join(' ') || process.env.OVERLEAF_QUERY_TEXT || process.env.OVERLEAF_PHRASE || '';
export const isId = /^[0-9a-fA-F]{24}$/.test(target);

export const OUT_DIR = runRecordingsDir('version_history_ui_phrase');
export const OUTPUT_PATH = process.env.OVERLEAF_OUTPUT || `${OUT_DIR}/summary.json`;
export const MAIN_TEX = process.env.OVERLEAF_MAIN_TEX || 'main.tex';
export const MAX_HISTORY_CLICKS = Math.max(0, Number.parseInt(process.env.OVERLEAF_HISTORY_MAX_CLICKS || '8', 10) || 0);

process.env.WELES_DISABLE_RECORDING = '1';
process.env.WELES_NO_RESPONSE_BODIES = '1';
process.env.WELES_CHROMIUM_NETLOG = '0';
process.env.WELES_FULL_DIAGNOSTICS = '0';
process.env.WELES_NO_INSTRUMENT = '1';
process.env.WELES_PAGE_DIAGNOSTICS = '0';

export const PROFILE_DIR = `${process.env.HOME}/Documents/CodingProjects/Wisent/weles/.work/overleaf_browser_profile`;
if (process.env.WELES_OVERLEAF_PERSISTENT_PROFILE !== '0' && !process.env.WELES_USER_DATA_DIR) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  process.env.WELES_USER_DATA_DIR = PROFILE_DIR;
}
