// The environment the section audit runs with: the checkouts it reads, where the run's
// report lands, the scan bounds, the selection switches and the Pangram accounts it rotates.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const WEL = new URL('../../../../..', import.meta.url).pathname.replace(/\/$/, '');
export const ROOT = (await import('#ncbr-settings')).applicationTextDir().replace(/\/$/, '');
// The application PDF is the caller's; no file under one person's Downloads is assumed.
export const PATH_A_PDF = process.env.PATH_A_PDF;
if (!PATH_A_PDF) throw new Error('PATH_A_PDF is not set: the application PDF the audit reads; nothing is assumed');
export const REPORT_ROOT = process.env.REPORT_ROOT || join(ROOT, 'pangram_section_audit');
export const TS = new Date().toISOString().replace(/[:.]/g, '-');
export const RUN_ID = process.env.WELES_RUN_ID || `ncbr-pangram-sections-ui-${TS}`;
export const OUT_DIR = process.env.OUT_DIR || join(REPORT_ROOT, RUN_ID);
export const SECTIONS_DIR = join(OUT_DIR, 'sections');
export const LOGS_DIR = join(OUT_DIR, 'logs');
// The scan bounds are the caller's: Pangram's own minimum and maximum input
// sizes are not published to this code, so each run states them.
function stated(name, what) {
  const raw = process.env[name];
  const value = Number(raw);
  if (!raw || !Number.isSafeInteger(value) || !(value >= Number.MIN_VALUE)) {
    throw new Error(`${name} is ${raw ? `"${raw}", not a whole number above zero` : 'not set'}: ${what}; nothing is assumed`);
  }
  return value;
}
export const MIN_WORDS = stated('MIN_WORDS', 'the fewest words a section must have to be scanned');
export const MIN_CHARS = stated('MIN_CHARS', 'the fewest characters a section must have to be scanned');
export const MAX_SCAN_CHARS = stated('MAX_SCAN_CHARS', 'the most characters one Pangram scan is given');
export const MAX_SCAN_WORDS = stated('MAX_SCAN_WORDS', 'the most words one Pangram scan is given');
export const SECTION_PATTERN = process.env.SECTION_PATTERN ? new RegExp(process.env.SECTION_PATTERN, 'i') : null;
export const ONLY_PATH = process.env.ONLY_PATH ? process.env.ONLY_PATH.toUpperCase() : null;
export const REUSE_EXISTING = process.env.REUSE_EXISTING !== '0';
export const COLLECT_ONLY = process.env.COLLECT_ONLY === '1';
export const NO_ACCOUNT = process.env.PANGRAM_NO_ACCOUNT === '1';

// The Pangram accounts rotated are the caller's; no account ids are built in.
export const accountIds = (process.env.ACCOUNT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
if (!NO_ACCOUNT && accountIds.length === 0) throw new Error('ACCOUNT_IDS is not set: the Pangram account ids the audit rotates (or PANGRAM_NO_ACCOUNT=1); nothing is assumed');

export function ensureDirs() {
  mkdirSync(SECTIONS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
}
