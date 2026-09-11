// The section 2.2 features and factors, parsed from the application's markdown source.
import { readFileSync } from 'node:fs';

const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.2_innowacyjnosc_i_zaleznosci.md';
const md = readFileSync(MD, 'utf8');

function clean(s) { return s.replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim(); }
function featureBlock(n) {
  const start = `### Cecha/funkcjonalność ${n}:`;
  const a = md.indexOf(start);
  if (a < 0) throw new Error(`feature ${n} missing`);
  const b = md.indexOf(`### Cecha/funkcjonalność ${n + 1}:`, a + start.length);
  return clean(md.slice(a, b >= 0 ? b : md.indexOf('## Rezultat prac B+R spełnia', a)));
}
function tableVal(block, label) {
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if ((cells[1] || '').includes(label)) return cells[2] || '';
  }
  return '';
}
export const FEATURES = [1, 2, 3, 4, 5].map((n) => {
  const block = featureBlock(n);
  return {
    cecha: tableVal(block, 'Cecha/funkcjonalność rezultatu projektu'),
    bazowa: tableVal(block, 'Wartość bazowa'),
    docelowa: tableVal(block, 'Wartość docelowa'),
    referencyjny: tableVal(block, 'Produkt/proces referencyjny'),
    korzysc: tableVal(block, 'Korzyść/przewaga'),
    weryfikacja: tableVal(block, 'Sposób weryfikacji'),
  };
}).filter((row) => row.cecha && row.docelowa);
const factorTable = md.slice(md.indexOf('## Podsumowanie wpływu prac B+R na ograniczanie'));
const factorRows = factorTable.split(/\r?\n/).filter((l) => l.trim().startsWith('|') && !/---|Wybrany czynnik/.test(l));
export const FACTORS = factorRows.map((line) => {
  const cells = line.split('|').map((c) => c.trim());
  return {
    czynnik: cells[1],
    parametr: cells[2],
    bazowa: cells[3],
    docelowa: cells[4],
    rokBazowy: cells[5],
    rokDocelowy: cells[6],
    metoda: cells[7],
    weryfikacja: cells[8],
  };
}).filter((row) => row.czynnik && row.parametr);
