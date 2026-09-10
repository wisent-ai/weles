// What repair_contacts_2_2_wsession.mjs writes: the contact, the e-Doreczenia address, and the
// section 2.2 features and factors parsed out of the application's markdown source.
import { readFileSync } from 'node:fs';

export const MD22 = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.2_innowacyjnosc_i_zaleznosci.md';
const md = readFileSync(MD22, 'utf8');
export const EDORECZENIA = 'AE:PL-50419-15057-VDGUG-25';
export const CONTACT = {
  imie: 'Zuzanna',
  nazwisko: 'Bartoszcze',
  stanowisko: 'Osoba do kontaktu organizacyjnego i finansowo-operacyjnego',
  telefon: '+48534110040',
  email: 'zuzanna.bartoszcze@gmail.com',
};

function clean(s) { return String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').replace(/\s+/g, ' ').trim(); }
function featureBlock(n) {
  const start = `### Cecha/funkcjonalność ${n}:`;
  const a = md.indexOf(start);
  if (a < 0) throw new Error(`feature ${n} missing`);
  const b = md.indexOf(`### Cecha/funkcjonalność ${n + 1}:`, a + start.length);
  const fallback = md.indexOf('## Rezultat prac B+R spełnia', a);
  return md.slice(a, b >= 0 ? b : fallback);
}
function tableVal(block, label) {
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim().startsWith('|') || /^\|\s*-/.test(line)) continue;
    const cells = line.split('|').map((c) => clean(c));
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
export const FACTORS = factorTable.split(/\r?\n/)
  .filter((line) => line.trim().startsWith('|') && !/---|Wybrany czynnik/.test(line))
  .map((line) => {
    const cells = line.split('|').map((c) => clean(c));
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
