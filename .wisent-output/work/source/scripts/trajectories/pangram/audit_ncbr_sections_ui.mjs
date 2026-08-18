// Batch Pangram UI audit for NCBR STEP Path A and Path B section texts.
// Uses pangram/analyze_text.mjs only, with response-body capture disabled.
// Never touches LSI/NCBR and never calls Pangram detection APIs directly.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

const WEL = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent';
const PATH_A_PDF = process.env.PATH_A_PDF || '/Users/lukaszbartoszcze/Downloads/Wniosek_nr_FENG.05.01-IP.01-005Z_26_wersja_A.pdf';
const REPORT_ROOT = process.env.REPORT_ROOT || join(ROOT, 'pangram_section_audit');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const RUN_ID = process.env.WELES_RUN_ID || `ncbr-pangram-sections-ui-${TS}`;
const OUT_DIR = process.env.OUT_DIR || join(REPORT_ROOT, RUN_ID);
const SECTIONS_DIR = join(OUT_DIR, 'sections');
const LOGS_DIR = join(OUT_DIR, 'logs');
const MIN_WORDS = Number(process.env.MIN_WORDS || 80);
const MIN_CHARS = Number(process.env.MIN_CHARS || 500);
const MAX_SCAN_CHARS = Number(process.env.MAX_SCAN_CHARS || 12_000);
const MAX_SCAN_WORDS = Number(process.env.MAX_SCAN_WORDS || 900);
const MAX_CHECKS = Number(process.env.MAX_CHECKS || 999);
const SECTION_PATTERN = process.env.SECTION_PATTERN ? new RegExp(process.env.SECTION_PATTERN, 'i') : null;
const ONLY_PATH = process.env.ONLY_PATH ? process.env.ONLY_PATH.toUpperCase() : null;
const REUSE_EXISTING = process.env.REUSE_EXISTING !== '0';
const COLLECT_ONLY = process.env.COLLECT_ONLY === '1';
const NO_ACCOUNT = process.env.PANGRAM_NO_ACCOUNT === '1';

const accountIds = (process.env.ACCOUNT_IDS || [
  'f9f9da66-887f-4158-a4d7-33e1182c2dbd',
  'a1ba1f64-b8c7-4ebd-83f3-3d9c95e485e9',
  '93ec0115-f96b-45c7-a417-335efed8b55a',
  'eba88574-3dfa-47f6-afa6-e77da7697169',
  'a27d61c6-ac85-478a-bbb7-974fd5b1360c',
  '9384a71b-5470-43fa-b6e4-a92c43fe2596',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd || WEL,
    env: { ...process.env, ...(opts.env || {}) },
    encoding: 'utf8',
    timeout: opts.timeoutMs || 120_000,
    maxBuffer: opts.maxBuffer || 80 * 1024 * 1024,
  });
  return res;
}

function ensureDirs() {
  mkdirSync(SECTIONS_DIR, { recursive: true });
  mkdirSync(LOGS_DIR, { recursive: true });
}

function slug(s) {
  return String(s)
    .normalize('NFKD')
    .replace(/[^\w.-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 110);
}

function sha(text) {
  return createHash('sha256').update(text).digest('hex');
}

function stats(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return {
    chars: text.length,
    words: clean ? clean.split(/\s+/).length : 0,
    sha256: sha(text),
    preview: clean.slice(0, 180),
  };
}

function splitLongText(text, maxChars = MAX_SCAN_CHARS) {
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

function cleanMarkdown(text) {
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

function cleanPdf(text) {
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

function findAll(text, re) {
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

const aDefs = [
  ['1.1', 'Informacje ogólne o projekcie', /^\s*1\.1\.\s+Informacje ogólne o projekcie/im],
  ['1.2', 'Klasyfikacja projektu', /^\s*1\.2\.\s+Klasyfikacja projektu/im],
  ['1.3', 'Podmioty realizujące projekt', /^\s*1\.3\.\s+Podmioty realizujące projekt/im],
  ['1.4', 'Konkurencja', /^\s*1\.4\.\s+Konkurencja/im],
  ['1.5', 'Miejsce realizacji projektu', /^\s*1\.5\.\s+Miejsce realizacji projektu/im],
  ['2.1', 'Cel projektu', /^\s*2\.1\.\s+Cel projektu/im],
  ['2.2', 'Innowacyjność rezultatu prac B+R', /^\s*2\.2\.\s+Innowacyjność rezultatu prac B\+R/im],
  ['2.3', 'Zapotrzebowanie rynkowe i potencjał gospodarczy innowacji', /^\s*2\.3\.\s+Zapotrzebowanie rynkowe i potencjał gospodarczy innowacji/im],
  ['2.4', 'Dodatkowe efekty zewnętrzne innowacji', /^\s*2\.4\.\s+Dodatkowe efekty zewnętrzne innowacji/im],
  ['3.1', 'Sposób wdrożenia wyników projektu', /^\s*3\.1\.\s+Sposób wdrożenia wyników projektu/im],
  ['3.2', 'Plan wdrożenia rezultatu projektu', /^\s*3\.2\.\s+Plan wdrożenia rezultatu projektu/im],
  ['3.3', 'Analiza opłacalności wdrożenia', /^\s*3\.3\.\s+Analiza opłacalności wdrożenia/im],
  ['3.4', 'Zasoby niezbędne do wdrożenia', /^\s*3\.4\.\s+Zasoby niezbędne do wdrożenia/im],
  ['3.5', 'Prawa własności intelektualnej', /^\s*3\.5\.\s+Prawa własności intelektualnej/im],
  ['4.1', 'Zespół projektowy', /^\s*4\.1\.\s+Zespół projektowy/im],
  ['4.2', 'Zasoby techniczne oraz wartości niematerialne i prawne', /^\s*4\.2\.\s+Zasoby techniczne oraz wartości niematerialne i prawne/im],
  ['4.3', 'Podwykonawcy', /^\s*4\.3\.\s+Podwykonawcy/im],
  ['5.1', 'Premia za skuteczną współpracę między przedsiębiorstwami', /^\s*5\.1\.\s+Premia za skuteczną współpracę między przedsiębiorstwami/im],
  ['5.2', 'Premia za skuteczną współpracę z organizacją badawczą', /^\s*5\.2\.\s+Premia za skuteczną współpracę z organizacją badawczą/im],
  ['5.3', 'Premia za lokalizację', /^\s*5\.3\.\s+Premia za lokalizację/im],
  ['5.4', 'Premia za rozpowszechnianie', /^\s*5\.4\.\s+Premia za rozpowszechnianie/im],
  ['6.1', 'Plan prac B+R', /^\s*6\.1\.\s+Plan prac B\+R/im],
  ['6.3', 'Wydatki rzeczywiste', /^\s*6\.3\.\s+Wydatki rzeczywiste/im],
  ['6.4', 'Podsumowanie wydatków rzeczywistych', /^\s*6\.4\.\s+Podsumowanie wydatków rzeczywistych/im],
  ['6.5', 'Koszty pośrednie', /^\s*6\.5\.\s+Koszty pośrednie/im],
  ['6.6', 'Podsumowanie HRF projektu', /^\s*6\.6\.\s+Podsumowanie HRF projektu/im],
  ['7', 'Analiza ryzyka', /^\s*7\.\s+ANALIZA RYZYKA/im],
  ['8', 'Źródła finansowania wydatków', /^\s*8\.\s+ŹRÓDŁA FINANSOWANIA WYDATKÓW/im],
  ['9.1', 'Wskaźniki produktu', /^\s*9\.1\.\s+Wskaźniki produktu/im],
  ['9.2', 'Wskaźniki rezultatu', /^\s*9\.2\.\s+Wskaźniki rezultatu/im],
  ['10.1', 'Horyzontalne zasady równości szans i niedyskryminacji', /^\s*10\.1\.\s+Horyzontalne zasady równości szans i niedyskryminacji/im],
  ['10.2', 'Zgodność projektu z Kartą Praw Podstawowych', /^\s*10\.2\.\s+Zgodność projektu z Kartą Praw Podstawowych/im],
  ['10.3', 'Zgodność projektu z Konwencją o Prawach Osób Niepełnosprawnych', /^\s*10\.3\.\s+Zgodność projektu z Konwencją o Prawach Osób Niepełnosprawnych/im],
  ['10.4', 'Zasada zrównoważonego rozwoju', /^\s*10\.4\.\s+Zasada zrównoważonego rozwoju/im],
];

function extractPathA() {
  if (!existsSync(PATH_A_PDF)) throw new Error(`Path A PDF not found: ${PATH_A_PDF}`);
  const res = sh('pdftotext', ['-layout', PATH_A_PDF, '-'], { cwd: ROOT, timeoutMs: 120_000 });
  if (res.status !== 0) throw new Error(`pdftotext failed: ${res.stderr || res.stdout}`);
  const text = cleanPdf(res.stdout);
  const occurrences = [];
  for (const def of aDefs) {
    for (const hit of findAll(text, def[2])) occurrences.push({ id: def[0], title: def[1], index: hit.index, match: hit.match });
  }
  occurrences.sort((a, b) => a.index - b.index);
  const sections = [];
  for (const def of aDefs) {
    const starts = occurrences.filter((o) => o.id === def[0]);
    if (!starts.length) {
      sections.push({ path: 'A', id: def[0], title: def[1], missing: true, text: '' });
      continue;
    }
    const candidates = starts.map((start) => {
      const next = occurrences.find((o) => o.index > start.index + start.match.length);
      const raw = text.slice(start.index, next ? next.index : text.length);
      const body = cleanPdf(raw);
      return { body, st: stats(body), startIndex: start.index };
    });
    candidates.sort((a, b) => b.st.words - a.st.words || b.st.chars - a.st.chars);
    sections.push({ path: 'A', id: def[0], title: def[1], source: PATH_A_PDF, text: candidates[0].body });
  }
  return sections;
}

function readRel(file) {
  const path = join(ROOT, file);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

function mdBetween(md, startRe, endRe = null) {
  const start = md.search(startRe);
  if (start < 0) return '';
  const after = md.slice(start);
  if (!endRe) return after;
  const m = after.slice(1).search(endRe);
  return m < 0 ? after : after.slice(0, m + 1);
}

function bFromFile(id, title, file, opts = {}) {
  const md = readRel(file);
  if (!md) return { path: 'B', id, title, source: join(ROOT, file), missing: true, text: '' };
  const raw = opts.startRe ? mdBetween(md, opts.startRe, opts.endRe) : md;
  return { path: 'B', id, title, source: join(ROOT, file), text: cleanMarkdown(raw) };
}

function bCompetitorsFromKimiRef() {
  const rel = 'DO_NOT_RUN_quarantine_20260620/save_1_4_collection.py';
  const path = join(ROOT, rel);
  if (!existsSync(path)) {
    return { path: 'B', id: '1.4', title: 'Konkurencja', source: path, missing: true, text: '', note: 'Brak lokalnej referencji Kimi dla B/1.4.' };
  }
  const py = readFileSync(path, 'utf8');
  const rows = py.split('"nazwa_podmiotu_konkurencyjnego":').slice(1);
  const parts = [];
  for (const row of rows) {
    const name = row.match(/^\s*"([^"]+)"/)?.[1] || 'Konkurent';
    const block = row.match(/"opis":\s*\(([\s\S]*?)\n\s*\),/)?.[1] || '';
    const sentences = [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => JSON.parse(`"${m[1]}"`))
      .join('');
    if (sentences.trim()) parts.push(`Konkurent: ${name}\n${sentences.trim()}`);
  }
  return { path: 'B', id: '1.4', title: 'Konkurencja', source: path, text: parts.join('\n\n') };
}

function extractPathB() {
  return [
    bFromFile('1.1', 'Informacje ogólne o projekcie', 'wersja_B_1_1_informacje_ogolne.md'),
    bFromFile('1.2', 'Klasyfikacja projektu', 'wersja_B_1_2_klasyfikacja.md'),
    bFromFile('1.3', 'Podmioty realizujące projekt', 'wersja_B_1_3_podmioty.md'),
    bCompetitorsFromKimiRef(),
    bFromFile('1.5', 'Miejsce realizacji projektu', 'wersja_B_1_5_miejsce_realizacji.md'),
    bFromFile('2.1', 'Cel projektu', 'wersja_B_2.1_cel_i_potrzeba.md'),
    bFromFile('2.2', 'Opis rezultatu prac B+R', 'wersja_B_2.2_innowacyjnosc_i_zaleznosci.md'),
    bFromFile('2.3', 'Zapotrzebowanie rynkowe i potencjał gospodarczy', 'wersja_B_2.3_rynek_i_potencjal.md'),
    bFromFile('2.4', 'Dodatkowe efekty zewnętrzne rezultatu prac B+R', 'wersja_B_2.4_efekty_zewnetrzne.md'),
    bFromFile('3.1', 'Sposób wdrożenia wyników projektu', 'wersja_B_3.1_3.2_3.3_3.4_wdrozenie.md', { startRe: /^##\s+3\.1\./m, endRe: /^##\s+3\.2\./m }),
    bFromFile('3.2', 'Plan wdrożenia rezultatu projektu', 'wersja_B_3.1_3.2_3.3_3.4_wdrozenie.md', { startRe: /^##\s+3\.2\./m, endRe: /^##\s+3\.3\./m }),
    bFromFile('3.3', 'Analiza opłacalności wdrożenia', 'wersja_B_3.1_3.2_3.3_3.4_wdrozenie.md', { startRe: /^##\s+3\.3\./m, endRe: /^##\s+3\.4\./m }),
    bFromFile('3.4', 'Zasoby niezbędne do wdrożenia', 'wersja_B_3.1_3.2_3.3_3.4_wdrozenie.md', { startRe: /^##\s+3\.4\./m, endRe: /^##\s+Podsumowanie zmian/m }),
    bFromFile('3.5', 'Prawa własności intelektualnej', 'wersja_B_3.5_prawa_wlasnosci.md'),
    bFromFile('4.1', 'Zespół projektowy', 'wersja_B_4_1_zespol.md'),
    bFromFile('4.2', 'Zasoby techniczne oraz WNiP', 'wersja_B_4_2_zasoby_techniczne.md'),
    bFromFile('4.3', 'Podwykonawcy', 'wersja_B_4_3_podwykonawcy.md'),
    bFromFile('5.1', 'Premia za skuteczną współpracę między przedsiębiorstwami', 'wersja_B_5_premie.md', { startRe: /^##\s+5\.1\./m, endRe: /^##\s+5\.2\./m }),
    bFromFile('5.2', 'Premia za skuteczną współpracę z organizacją badawczą', 'wersja_B_5_premie.md', { startRe: /^##\s+5\.2\./m, endRe: /^##\s+5\.3\./m }),
    bFromFile('5.3', 'Premia za lokalizację', 'wersja_B_5_premie.md', { startRe: /^##\s+5\.3\./m, endRe: /^##\s+5\.4\./m }),
    bFromFile('5.4', 'Premia za rozpowszechnianie', 'wersja_B_5_premie.md', { startRe: /^##\s+5\.4\./m }),
    bFromFile('6.1', 'Plan prac B+R', 'wersja_B_6_harmonogram.md', { startRe: /^##\s+6\.1\./m, endRe: /^##\s+6\.2\./m }),
    bFromFile('6.2', 'Wykres Gantta', 'wersja_B_6_harmonogram.md', { startRe: /^##\s+6\.2\./m, endRe: /^##\s+6\.3\./m }),
    bFromFile('6.3', 'Wydatki rzeczywiste', 'wersja_B_6_harmonogram.md', { startRe: /^##\s+6\.3\./m, endRe: /^##\s+6\.4\./m }),
    bFromFile('6.4', 'Podsumowanie wydatków rzeczywistych', 'wersja_B_6_harmonogram.md', { startRe: /^##\s+6\.4\./m, endRe: /^##\s+6\.5\./m }),
    bFromFile('6.5', 'Koszty pośrednie', 'wersja_B_6_harmonogram.md', { startRe: /^##\s+6\.5\./m, endRe: /^##\s+6\.6\./m }),
    bFromFile('6.6', 'Podsumowanie HRF projektu', 'wersja_B_6_harmonogram.md', { startRe: /^##\s+6\.6\./m }),
    bFromFile('7', 'Analiza ryzyka', 'wersja_B_7_ryzyka.md'),
    { path: 'B', id: '8', title: 'Źródła finansowania wydatków', missing: true, text: '', note: 'Brak lokalnego pliku narracyjnego dla B/8; sekcja finansowania jest tabelaryczna.' },
    bFromFile('9.1', 'Wskaźniki produktu', 'wersja_B_9_1_wskazniki_produktu.md'),
    bFromFile('9.2', 'Wskaźniki rezultatu', 'wersja_B_9.2_wskazniki.md'),
    bFromFile('10.1', 'Horyzontalne zasady równości szans i niedyskryminacji', 'wersja_B_10_1_rowność.md'),
    bFromFile('10.2', 'Zgodność projektu z Kartą Praw Podstawowych', 'wersja_B_10_2_karta_praw.md'),
    bFromFile('10.3', 'Zgodność projektu z Konwencją o Prawach Osób Niepełnosprawnych', 'wersja_B_10_3_niepelnosprawni.md'),
    bFromFile('10.4', 'Zasada zrównoważonego rozwoju', 'wersja_B_10.4_zrownowazony_rozwoj.md'),
  ];
}

function walkJson(dir, limit = 20_000) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const cur = stack.pop();
    let entries = [];
    try { entries = readdirSync(cur, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name === 'pangram_result.json') out.push(p);
    }
  }
  return out;
}

function loadExistingUiResults() {
  const map = new Map();
  if (!REUSE_EXISTING) return map;
  const recordings = join(WEL, 'recordings');
  if (!existsSync(recordings)) return map;
  for (const p of walkJson(recordings)) {
    try {
      const json = JSON.parse(readFileSync(p, 'utf8'));
      const key = json?.input?.sha256;
      if (key && json.source === 'ui' && json.verdict) {
        const prev = map.get(key);
        const mtime = statSync(p).mtimeMs;
        if (!prev || mtime > prev.mtime) map.set(key, { path: p, mtime, result: json });
      }
    } catch {
      // Ignore corrupt or partial files.
    }
  }
  return map;
}

function resultDirFor(action) {
  return join(WEL, 'recordings', RUN_ID, action);
}

function runPangram(item, textFile, action, accountId = '') {
  const resultPath = join(resultDirFor(action), 'pangram_result.json');
  const banPath = join(resultDirFor(action), 'ban_signal.json');
  rmSync(resultPath, { force: true });
  rmSync(banPath, { force: true });
  const env = {
    WELES_RUN_ID: RUN_ID,
    ACTION: action,
    PANGRAM_TEXT_FILE: textFile,
    WELES_FORCE_OS: process.env.WELES_FORCE_OS || 'macos',
    WELES_CAPTURE_RESPONSE_BODIES: '0',
    PANGRAM_ANALYZE_TIMEOUT_MS: process.env.PANGRAM_ANALYZE_TIMEOUT_MS || '120000',
    PANGRAM_MIN_WORDS: String(MIN_WORDS),
    PANGRAM_MIN_CHARS: String(MIN_CHARS),
    PANGRAM_ACCOUNT_USAGE_FILE: join(OUT_DIR, 'pangram-account-usage.json'),
    PANGRAM_AUTO_REGISTER: process.env.PANGRAM_AUTO_REGISTER || '0',
    PANGRAM_MAX_AUTO_REGISTERS: process.env.PANGRAM_MAX_AUTO_REGISTERS || '0',
  };
  if (NO_ACCOUNT) {
    env.PANGRAM_NO_ACCOUNT = '1';
    env.PANGRAM_WAIT_FOR_HUMAN_VERIFICATION = process.env.PANGRAM_WAIT_FOR_HUMAN_VERIFICATION || '1';
    env.PANGRAM_HUMAN_VERIFICATION_TIMEOUT_MS = process.env.PANGRAM_HUMAN_VERIFICATION_TIMEOUT_MS || '180000';
  } else {
    env.PANGRAM_REQUIRE_ACCOUNT = '1';
  }
  if (accountId) env.ACCOUNT_ID = accountId;
  const res = sh(process.execPath, ['--env-file=.env', 'scripts/trajectories/pangram/analyze_text.mjs'], {
    cwd: WEL,
    env,
    timeoutMs: Number(process.env.PANGRAM_SECTION_TIMEOUT_MS || 210_000),
    maxBuffer: 20 * 1024 * 1024,
  });
  const partSuffix = item.part ? `_p${String(item.part).padStart(2, '0')}` : '';
  const logPath = join(LOGS_DIR, `${slug(item.path)}_${slug(item.id)}${partSuffix}_${slug(accountId || 'auto')}.log`);
  writeFileSync(logPath, `${res.stdout || ''}\n${res.stderr || ''}`.trim());
  const result = existsSync(resultPath) ? JSON.parse(readFileSync(resultPath, 'utf8')) : null;
  const ban = existsSync(banPath) ? JSON.parse(readFileSync(banPath, 'utf8')) : null;
  return { res, logPath, resultPath, banPath, result, ban, accountId };
}

function trustedResult(run) {
  return run.res.status === 0 && run.ban?.healthy === true && run.result?.source === 'ui' && run.result?.verdict;
}

function markdownReport(report) {
  const lines = [];
  lines.push('# Pangram UI audit: NCBR STEP Path A and Path B');
  lines.push('');
  lines.push(`Run: \`${report.runId}\``);
  lines.push(`Generated: \`${report.generatedAt}\``);
  lines.push('');
  lines.push('Rules: Pangram UI trajectory only; `WELES_CAPTURE_RESPONSE_BODIES=0`; non-UI outputs rejected.');
  lines.push('');
  lines.push('| Path | Section | Part | Status | Verdict | AI % | Human % | Words | Source |');
  lines.push('|---|---:|---:|---|---|---:|---:|---:|---|');
  for (const r of report.results) {
    lines.push(`| ${r.path} | ${r.id} | ${r.part_count > 1 ? `${r.part}/${r.part_count}` : ''} | ${r.status}${r.reused ? ' reused' : ''} | ${r.verdict ?? ''} | ${r.ai_percent ?? ''} | ${r.human_percent ?? ''} | ${r.words ?? 0} | ${r.source_file ? basename(r.source_file) : ''} |`);
  }
  lines.push('');
  const ai = report.results.filter((r) => r.verdict === 'ai_generated');
  if (ai.length) {
    lines.push('## AI-generated flags');
    for (const r of ai) lines.push(`- ${r.path} ${r.id}: ${r.title} (${r.ai_percent}% AI)`);
    lines.push('');
  }
  const skipped = report.results.filter((r) => r.status !== 'checked' && r.status !== 'reused');
  if (skipped.length) {
    lines.push('## Not checked');
    for (const r of skipped) lines.push(`- ${r.path} ${r.id}: ${r.status}${r.note ? ` - ${r.note}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}

ensureDirs();

let items = [...extractPathA(), ...extractPathB()];
items = items.filter((it) => (!ONLY_PATH || it.path === ONLY_PATH) && (!SECTION_PATTERN || SECTION_PATTERN.test(`${it.path} ${it.id} ${it.title}`)));
items.sort((a, b) => `${a.path} ${a.id}`.localeCompare(`${b.path} ${b.id}`, 'pl', { numeric: true }));

const existing = loadExistingUiResults();
const results = [];
let checks = 0;
let accountCursor = 0;

for (const item of items) {
  const st = stats(item.text || '');
  const fullTextFile = join(SECTIONS_DIR, `${slug(item.path)}_${slug(item.id)}_${slug(item.title)}.txt`);
  if (item.text) writeFileSync(fullTextFile, item.text);
  const base = {
    path: item.path,
    id: item.id,
    title: item.title,
    source_file: item.source || null,
    text_file: item.text ? fullTextFile : null,
    part: 1,
    part_count: 1,
    ...st,
  };
  if (item.missing) {
    results.push({ ...base, status: 'missing_source', note: item.note || 'source missing' });
    continue;
  }
  if (st.words < MIN_WORDS || st.chars < MIN_CHARS) {
    results.push({ ...base, status: 'skipped_short', note: `below Pangram minimum ${MIN_WORDS} words / ${MIN_CHARS} chars` });
    continue;
  }
  const chunks = splitLongText(item.text, MAX_SCAN_CHARS);
  for (const chunk of chunks) {
    const chunkStats = stats(chunk.text);
    const partCount = chunks.length;
    const chunkFile = partCount === 1
      ? fullTextFile
      : join(SECTIONS_DIR, `${slug(item.path)}_${slug(item.id)}_${slug(item.title)}_part_${String(chunk.part).padStart(2, '0')}.txt`);
    if (partCount > 1) writeFileSync(chunkFile, chunk.text);
    const chunkBase = {
      ...base,
      text_file: chunkFile,
      part: chunk.part,
      part_count: partCount,
      ...chunkStats,
    };
    if (chunkStats.words < MIN_WORDS || chunkStats.chars < MIN_CHARS) {
      results.push({ ...chunkBase, status: 'skipped_short', note: `split part below Pangram minimum ${MIN_WORDS} words / ${MIN_CHARS} chars` });
      continue;
    }
    const cached = existing.get(chunkStats.sha256);
    if (cached) {
      results.push({
        ...chunkBase,
        status: 'reused',
        reused: true,
        verdict: cached.result.verdict ?? null,
        ai_percent: cached.result.ai_percent ?? null,
        human_percent: cached.result.human_percent ?? null,
        pangram_source: cached.result.source,
        artifact: cached.path,
      });
      continue;
    }
    if (COLLECT_ONLY) {
      results.push({ ...chunkBase, status: 'collected_only' });
      continue;
    }
    if (checks >= MAX_CHECKS) {
      results.push({ ...chunkBase, status: 'pending_max_checks' });
      continue;
    }
    checks += 1;
    const action = `pangram_ncbr_${slug(item.path)}_${slug(item.id)}_p${String(chunk.part).padStart(2, '0')}_${slug(TS)}`;
    let accepted = null;
    const attempts = [];
    const maxAttempts = NO_ACCOUNT ? 1 : Math.max(1, accountIds.length);
    for (let i = 0; i < maxAttempts; i++) {
      const accountId = NO_ACCOUNT ? '' : (accountIds[(accountCursor + i) % accountIds.length] || '');
      console.error(`[audit] ${item.path} ${item.id}${partCount > 1 ? ` part ${chunk.part}/${partCount}` : ''} ${item.title}: attempt ${NO_ACCOUNT ? 'public-ui' : `account=${accountId || 'auto'}`} words=${chunkStats.words}`);
      const run = runPangram({ ...item, part: chunk.part }, chunkFile, action, accountId);
      attempts.push({
        accountId,
        exitCode: run.res.status,
        signal: run.ban?.signal || null,
        healthy: run.ban?.healthy ?? null,
        source: run.result?.source || null,
        verdict: run.result?.verdict || null,
        logPath: run.logPath,
        resultPath: existsSync(run.resultPath) ? run.resultPath : null,
        banPath: existsSync(run.banPath) ? run.banPath : null,
      });
      if (trustedResult(run)) {
        accepted = run;
        if (!NO_ACCOUNT) accountCursor = (accountCursor + i + 1) % Math.max(1, accountIds.length);
        break;
      }
      const signal = run.ban?.signal || '';
      if (!/insufficient_credits|quota_exhausted|checkpoint|no_account|unknown_error|auth_required|captcha_required/i.test(signal)) break;
    }
    if (accepted) {
      results.push({
        ...chunkBase,
        status: 'checked',
        verdict: accepted.result.verdict ?? null,
        ai_percent: accepted.result.ai_percent ?? null,
        human_percent: accepted.result.human_percent ?? null,
        pangram_source: accepted.result.source,
        artifact: accepted.resultPath,
        attempts,
      });
    } else {
      results.push({ ...chunkBase, status: 'failed', attempts });
    }
    const partial = {
      runId: RUN_ID,
      generatedAt: new Date().toISOString(),
      outDir: OUT_DIR,
      results,
    };
    writeFileSync(join(OUT_DIR, 'audit_report.partial.json'), JSON.stringify(partial, null, 2));
  }
}

const report = {
  runId: RUN_ID,
  generatedAt: new Date().toISOString(),
  outDir: OUT_DIR,
  pathA: { pdf: PATH_A_PDF },
  pathB: { root: ROOT, source: 'wersja_B markdown files; no final Path B PDF found locally' },
  minWords: MIN_WORDS,
  minChars: MIN_CHARS,
  collectOnly: COLLECT_ONLY,
  reusedExisting: REUSE_EXISTING,
  checkedCount: results.filter((r) => r.status === 'checked' || r.status === 'reused').length,
  aiGeneratedCount: results.filter((r) => r.verdict === 'ai_generated').length,
  humanCount: results.filter((r) => r.verdict === 'human').length,
  failedCount: results.filter((r) => r.status === 'failed').length,
  skippedCount: results.filter((r) => !['checked', 'reused'].includes(r.status)).length,
  results,
};

writeFileSync(join(OUT_DIR, 'audit_report.json'), JSON.stringify(report, null, 2));
writeFileSync(join(OUT_DIR, 'audit_report.md'), markdownReport(report));
console.log(JSON.stringify({
  runId: RUN_ID,
  outDir: OUT_DIR,
  checkedCount: report.checkedCount,
  humanCount: report.humanCount,
  aiGeneratedCount: report.aiGeneratedCount,
  failedCount: report.failedCount,
  skippedCount: report.skippedCount,
  reportJson: join(OUT_DIR, 'audit_report.json'),
  reportMd: join(OUT_DIR, 'audit_report.md'),
}, null, 2));

process.exit(report.failedCount ? 2 : 0);
