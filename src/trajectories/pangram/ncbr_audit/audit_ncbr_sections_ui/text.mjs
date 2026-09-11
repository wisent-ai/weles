// The text tools: running a command from the Weles checkout, slugs and hashes, word and
// character counts, splitting a long text into scans, cleaning markdown and PDF text.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MAX_SCAN_CHARS, MAX_SCAN_WORDS, MIN_CHARS, MIN_WORDS, WEL } from './settings.mjs';

export function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || WEL,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120_000,
    maxBuffer: opts.maxBuffer || 80 * 1024 * 1024,
  });
  return res;
}

export function slug(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 110);
}

export function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function stats(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return {
    chars: text.length,
    words: clean ? clean.split(/\s+/).length : 0,
    sha256: sha(text),
    preview: clean.slice(0, 180),
  };
}

export function splitLongText(text, maxChars = MAX_SCAN_CHARS) {
  const fits = (s) => s.length <= maxChars && stats(s).words <= MAX_SCAN_WORDS;
  if (fits(text)) return [{ part: 1, text }];
  const chunks = [];
  let current = '';
  const pushCurrent = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = '';
  };
  const pieces = text.split(/\n{2,}/).flatMap((p) => {
    if (p.length <= maxChars) return [p];
    return p
      .split(/(?<=[.!?])\s+(?=[A-ZĄĆĘŁŃÓŚŹŻ0-9])/)
      .filter(Boolean);
  });
  for (const piece of pieces) {
    const p = piece.trim();
    if (!p) continue;
    if (!current) {
      current = p;
    } else if (fits(`${current}\n\n${p}`)) {
      current = `${current}\n\n${p}`;
    } else {
      pushCurrent();
      current = p;
    }
    while (!fits(current)) {
      const cut = current.slice(0, maxChars);
      const words = current.trim().split(/\s+/);
      let byWords = current.length;
      if (words.length > MAX_SCAN_WORDS) byWords = words.slice(0, MAX_SCAN_WORDS).join(' ').length;
      const hard = Math.min(maxChars, byWords);
      const slice = current.slice(0, hard);
      const lastSpace = slice.lastIndexOf(' ');
      const at = lastSpace > Math.floor(hard * 0.75) ? lastSpace : hard;
      chunks.push(current.slice(0, at).trim());
      current = current.slice(at).trim();
    }
  }
  pushCurrent();
  if (chunks.length > 1) {
    const last = chunks[chunks.length - 1];
    const lastStats = stats(last);
    if ((lastStats.words < MIN_WORDS || lastStats.chars < MIN_CHARS) && fits(`${chunks[chunks.length - 2]}\n\n${last}`)) {
      chunks[chunks.length - 2] = `${chunks[chunks.length - 2]}\n\n${last}`;
      chunks.pop();
    }
  }
  return chunks.map((chunk, i) => ({ part: i + 1, text: chunk }));
}

export function cleanMarkdown(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/__(.*?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*\|?[-:| ]+\|?\s*$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function cleanPdf(text) {
  return String(text || '')
    .replace(/\f/g, '\n')
    .replace(/\r/g, '')
    .replace(/^\s*\d+\s*$/gm, '')
    .replace(/^Narodowe Centrum Badań i Rozwoju.*$/gmi, '')
    .replace(/^Wniosek o dofinansowanie projektu.*$/gmi, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function findAll(text, re) {
  const flags = re.flags.includes('g') ? re.flags : `${re.flags}g`;
  const rx = new RegExp(re.source, flags);
  const out = [];
  let m;
  while ((m = rx.exec(text)) !== null) {
    out.push({ index: m.index, match: m[0] });
    if (m[0].length === 0) rx.lastIndex += 1;
  }
  return out;
}
