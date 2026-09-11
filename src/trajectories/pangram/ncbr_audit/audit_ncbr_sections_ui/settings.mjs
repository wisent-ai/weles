// The environment the section audit runs with: the checkouts it reads, where the run's
// report lands, the scan bounds, the selection switches and the Pangram accounts it rotates.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const WEL = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles';
export const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent';
export const PATH_A_PDF = process.env.PATH_A_PDF || '/Users/lukaszbartoszcze/Downloads/Wniosek_nr_FENG.05.01-IP.01-005Z_26_wersja_A.pdf';
export const REPORT_ROOT = process.env.REPORT_ROOT || join(ROOT, 'pangram_section_audit');
export const TS = new Date().toISOString().replace(/[:.]/g, '-');
export const RUN_ID = process.env.WELES_RUN_ID || `ncbr-pangram-sections-ui-${TS}`;
export const OUT_DIR = process.env.OUT_DIR || join(REPORT_ROOT, RUN_ID);
export const SECTIONS_DIR = join(OUT_DIR, 'sections');
export const LOGS_DIR = join(OUT_DIR, 'logs');
export const MIN_WORDS = Number(process.env.MIN_WORDS || 80);
export const MIN_CHARS = Number(process.env.MIN_CHARS || 500);
export const MAX_SCAN_CHARS = Number(process.env.MAX_SCAN_CHARS || 12_000);
export const MAX_SCAN_WORDS = Number(process.env.MAX_SCAN_WORDS || 900);
export const MAX_CHECKS = Number(process.env.MAX_CHECKS || 999);
export const SECTION_PATTERN = process.env.SECTION_PATTERN ? new RegExp(process.env.SECTION_PATTERN, 'i') : null;
export const ONLY_PATH = process.env.ONLY_PATH ? process.env.ONLY_PATH.toUpperCase() : null;
export const REUSE_EXISTING = process.env.REUSE_EXISTING !== '0';
export const COLLECT_ONLY = process.env.COLLECT_ONLY === '1';
export const NO_ACCOUNT = process.env.PANGRAM_NO_ACCOUNT === '1';

export const accountIds = (process.env.ACCOUNT_IDS || [
  'f9f9da66-887f-4158-a4d7-33e1182c2dbd',
  'a1ba1f64-b8c7-4ebd-83f3-3d9c95e485e9',
  '93ec0115-f96b-45c7-a417-335efed8b55a',
  'eba88574-3dfa-47f6-afa6-e77da7697169',
  'a27d61c6-ac85-478a-bbb7-974fd5b1360c',
  '9384a71b-5470-43fa-b6e4-a92c43fe2596',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

export function ensureDirs() {
  mkdirSync(SECTIONS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
}
