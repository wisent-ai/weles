// The section texts: Path A from the submitted PDF, Path B from the replacement draft's
// markdown files.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PATH_A_PDF, ROOT } from './settings.mjs';
import { cleanMarkdown, cleanPdf, findAll, sh, stats } from './text.mjs';

export const aDefs = [
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

export function extractPathA() {
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

export function readRel(file) {
  const path = join(ROOT, file);
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}

export function mdBetween(md, startRe, endRe = null) {
  const start = md.search(startRe);
  if (start < 0) return '';
  const after = md.slice(start);
  if (!endRe) return after;
  const m = after.slice(1).search(endRe);
  return m < 0 ? after : after.slice(0, m + 1);
}

export function bFromFile(id, title, file, opts = {}) {
  const md = readRel(file);
  if (!md) return { path: 'B', id, title, source: join(ROOT, file), missing: true, text: '' };
  const raw = opts.startRe ? mdBetween(md, opts.startRe, opts.endRe) : md;
  return { path: 'B', id, title, source: join(ROOT, file), text: cleanMarkdown(raw) };
}

export function bCompetitorsFromKimiRef() {
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

export function extractPathB() {
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
