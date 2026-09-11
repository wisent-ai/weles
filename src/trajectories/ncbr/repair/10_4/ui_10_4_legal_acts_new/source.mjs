// The vetted legal-act rows of section 10.4, parsed from the application's markdown source,
// the stale rows to remove, and the needles that find a row in the table.
import { readFileSync } from 'node:fs';

const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_10.4_zrownowazony_rozwoj.md';

const md = readFileSync(MD, 'utf8');

function legalRows() {
  return md.split('\n')
    .filter((line) => line.startsWith('| **') && !line.includes('|---|'))
    .map((line) => {
      const cells = line.split('|').map((cell) => cell.trim());
      const act = (cells[1] || '').replace(/\*\*/g, '');
      const justification = (cells[2] || '').replace(/\*\*/g, '');
      if (!act || !justification) throw new Error(`malformed legal-act row: ${line.slice(0, 120)}`);
      const formJustification = act.startsWith('Inne:') ? `${act}. ${justification}` : justification;
      if (formJustification.length > 1000) throw new Error(`legal-act justification too long: ${act} ${formJustification.length}/1000`);
      return { act, kind: act.startsWith('Inne:') ? 'inne' : 'lista', justification, justificationLength: justification.length, formJustification, formJustificationLength: formJustification.length };
    });
}

export const targets = legalRows();
export const target = targets[0];
export const staleNeedles = [
  ['2010/75'],
  ['emisji przemys'],
];

export function rowNeedles(row) {
  if (/2018\/2001/i.test(row.act)) return ['2018/2001'];
  if (/2023\/1791/i.test(row.act)) return ['2023/1791'];
  if (/2024\/1364/i.test(row.act)) return ['2024/1364'];
  if (row.kind === 'inne') return [row.act.replace(/^Inne:\s*/, '').slice(0, 40)];
  if (/odpadach/i.test(row.act)) return ['odpadach'];
  if (/Prawo ochrony środowiska/i.test(row.act)) return ['Prawo ochrony środowiska'];
  if (/Prawo wodne/i.test(row.act)) return ['Prawo wodne'];
  if (/ochronie przyrody/i.test(row.act)) return ['ustawa o ochronie przyrody', 'ochronie przyrody'];
  if (/3 października 2008|udostępnianiu informacji/i.test(row.act)) return ['ustawa OOŚ', 'udostępnianiu informacji'];
  return [row.act];
}
