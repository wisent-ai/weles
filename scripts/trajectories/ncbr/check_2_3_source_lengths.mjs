import { readFileSync } from 'node:fs';

const SRC = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md';
const md = readFileSync(SRC, 'utf8');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function rows(sectionTitle, nextTitle) {
  const start = md.indexOf(sectionTitle);
  const end = md.indexOf(nextTitle, start);
  if (start < 0 || end < 0) throw new Error(`markers missing: ${sectionTitle}`);
  return md.slice(start, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map(clean))
    .filter((cells) => cells.length === 5 && cells[0] !== 'Podmiot konkurencyjny')
    .map((cells) => ({
      podmiot: cells[0],
      produkt: cells[2].length,
      funkcjonalnosci: cells[3].length,
      korzysc: cells[4].length,
      productShortBy: 200 - cells[2].length,
      benefitShortBy: 1000 - cells[4].length,
    }));
}

function rowValue(block, label) {
  const line = block.split(/\r?\n/).find((l) => l.startsWith('|') && l.toLowerCase().includes(label.toLowerCase()));
  if (!line) throw new Error(`row missing: ${label}`);
  return clean(line.split('|').slice(1, -1)[1]);
}

function params() {
  const title = '## Parametry opisujące znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE';
  const start = md.indexOf(title);
  if (start < 0) throw new Error('parameter section missing');
  return md.slice(start + title.length)
    .split(/^### Parametr \d+\s*$/m)
    .slice(1)
    .map((block) => {
      const name = rowValue(block, 'Nazwa parametru');
      const method = rowValue(block, 'Metoda oszacowania');
      const verify = rowValue(block, 'Sposób monitorowania');
      return {
        nameHead: name.slice(0, 80),
        name: name.length,
        method: method.length,
        verify: verify.length,
        nameShortBy: 500 - name.length,
        methodShortBy: 1000 - method.length,
        verifyShortBy: 800 - verify.length,
      };
    });
}

const out = {
  eu: rows('## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE'),
  nonEu: rows('## Oferta konkurencji spoza UE', '## Rynek docelowy dla innowacji produktowej'),
  params: params(),
};

console.log(JSON.stringify(out, null, 2));
