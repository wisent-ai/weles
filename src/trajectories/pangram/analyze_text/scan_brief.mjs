// The scan request: which operator input channel supplied the text and in which
// order the channels win, which dashboard URL the run opens, how the text is
// fingerprinted in the evidence record, and where the artifacts are written.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

export const LABEL = 'pangram_analyze_text';
export const RESULT_FILE = 'pangram_result.json';

function baseUrl(raw, defaultUrl) {
  return String(raw || defaultUrl).replace(/\/+$/, '');
}

export function dashboardUrl() {
  if (process.env.PANGRAM_ANALYZE_URL) return process.env.PANGRAM_ANALYZE_URL;
  const base = baseUrl(process.env.PANGRAM_BASE_URL || process.env.PANGRAM_URL, 'https://www.pangram.com');
  return `${base}/`;
}

export function inputText() {
  const direct = process.env.PANGRAM_TEXT || process.env.SVC_TEXT || process.env.TEXT || '';
  if (direct.trim()) return direct;
  const path = process.env.PANGRAM_TEXT_FILE || process.env.TEXT_FILE || process.env.MESSAGE_FILE || '';
  if (path && existsSync(path)) return readFileSync(path, 'utf8');
  return '';
}

export function textStats(text) {
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  return {
    chars: text.length,
    words,
    sha256: createHash('sha256').update(text).digest('hex'),
    preview: text.replace(/\s+/g, ' ').trim().slice(0, 120),
  };
}

export function writeJson(name, value) {
  const dir = runRecordingsDir(process.env.ACTION || LABEL);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}

export function mergeResult(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v !== null && v !== undefined && out[k] === undefined) out[k] = v;
  }
  return out;
}
