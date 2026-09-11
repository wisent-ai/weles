// Rewrites the section 2.3 markdown source: the competitor tables inside and outside the EU,
// and the parameter blocks, each fitted to the application's field limits.
import { readFileSync, writeFileSync } from 'node:fs';
import { EU, NON_EU } from './repair_2_3_dense_source/competitors.mjs';
import { PARAMS } from './repair_2_3_dense_source/params.mjs';

const SRC = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md';

function table(rows) {
  return [
    '| Podmiot konkurencyjny | Kraj siedziby | Produkt / rozwiązanie | Funkcjonalności | Korzyść / przewaga RNM |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.podmiot} | ${r.kraj} | ${r.produkt} | ${r.funkcjonalnosci} | ${r.korzysc} |`),
  ].join('\n');
}

function replaceBetween(source, startMarker, endMarker, body) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  if (start < 0 || end < 0) throw new Error(`markers missing: ${startMarker}`);
  return `${source.slice(0, start + startMarker.length)}\n\n${body}\n\n${source.slice(end)}`;
}

function paramBlock(p, index) {
  return `### Parametr ${index}

| Pole | Wartość |
|---|---|
| Nazwa parametru | ${p.name} |
| Wartość bazowa (z jednostką miary) | ${p.base} |
| Rok bazowy | ${p.baseYear} |
| Wartość docelowa (z jednostką miary) | ${p.target} |
| Rok docelowy | ${p.targetYear} |
| Metoda oszacowania wartości docelowej | ${p.method} |
| Sposób monitorowania / weryfikacji osiągnięcia zaplanowanych wartości docelowych | ${p.verify} |`;
}

let md = readFileSync(SRC, 'utf8');
md = replaceBetween(md, '## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE', table(EU));
md = replaceBetween(md, '## Oferta konkurencji spoza UE', '## Rynek docelowy dla innowacji produktowej', table(NON_EU));

const paramTitle = '## Parametry opisujące znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE';
const paramStart = md.indexOf(paramTitle);
if (paramStart < 0) throw new Error('parameter section missing');
md = `${md.slice(0, paramStart + paramTitle.length)}\n\n${PARAMS.map((p, i) => paramBlock(p, i + 1)).join('\n\n')}\n`;

writeFileSync(SRC, md);
console.log(JSON.stringify({ ok: true, file: SRC, eu: EU.length, nonEu: NON_EU.length, params: PARAMS.length }, null, 2));
