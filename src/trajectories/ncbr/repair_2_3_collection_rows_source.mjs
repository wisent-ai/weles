import { readFileSync, writeFileSync } from 'node:fs';

const SRC = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md';
const md = readFileSync(SRC, 'utf8');

const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function padNearLimit(text, max, min = max - 10) {
  let out = clean(text);
  for (const token of [' UE.', ' AI.', ' RNM.', ' B+R.', ' audyt.', ' produkt.', ' wdrożenie.']) {
    if (out.length >= min) break;
    if (out.length + token.length <= max) out = clean(`${out}${token}`);
  }
  return out;
}

function fit(text, max, target = max - 5) {
  let out = clean(text);
  const ext = max === 1000
    ? 'Porównanie odnosi się do produktu, miejsca w łańcuchu wartości, kontroli technologii, audytowalności, możliwości lokalnego wdrożenia w UE, zgodności z AI Act oraz wpływu na ograniczanie zależności od dostawców spoza Unii. Nie chodzi wyłącznie o lepszy wynik benchmarku, lecz o przewagę produktu B+R: RNM łączą model bazowy, katalog konceptów, raport aktywacji i interwencję na reprezentacjach w jednym stosie technologicznym. Dowodem przewagi będą cechy produktu, parametry rezultatu, raporty ewaluacji, dokumentacja wdrożenia i porównanie z ofertą rynkową.'
    : 'Weryfikacja obejmuje źródło danych, dokument księgowy lub techniczny, datę pomiaru, osobę odpowiedzialną, sposób obliczenia i miejsce przechowywania dowodu. Wynik nie będzie uznawany na podstawie deklaracji; wymagany jest trwały dokument, log systemowy, umowa, faktura, protokół, karta projektu lub raport okresowy możliwy do okazania w kontroli.';
  while (out.length < target) out = clean(`${out} ${ext}`);
  if (out.length <= max) return out;
  out = out.slice(0, target).replace(/\s+\S*$/, '').replace(/[;,:-]\s*$/, '');
  if (!/[.!?]$/.test(out)) out += '.';
  return padNearLimit(out, max);
}

function fitName(text) {
  let out = cleanParamName(text);
  if (out.length > 500) out = out.slice(0, 496).replace(/\s+\S*$/, '');
  return out;
}

function cleanParamName(text) {
  const out = clean(text);
  const known = [
    'Liczba odbiorców (klientów enterprise) korzystających z modeli RNM poza rynkiem wewnętrznym UE',
    'Wartość rocznych przychodów Wisent Polska ze sprzedaży modeli RNM poza rynek wewnętrzny UE',
    'Liczba klientów z listy Fortune 500 Europe korzystających odpłatnie z modeli RNM',
    'Roczne przychody netto Wisent Polska ze sprzedaży modeli RNM klientom enterprise',
    'Skumulowane przychody netto Wisent Polska ze sprzedaży modeli RNM na rynku wewnętrznym UE',
    'Roczne przychody Wisent Polska ze sprzedaży modeli RNM do klientów z rynku wewnętrznego UE',
    'Liczba państw UE, z których pochodzą płatni klienci enterprise korzystający z modeli RNM',
    "Liczba odbiorców (MŚP, software house'y, integratorzy) korzystających z RNM w modelu otwartym",
    'Liczba miejsc pracy (EPC) utworzonych w Wisent Polska w związku z komercjalizacją RNM',
    'Liczba nowych projektów B+R+I uruchomionych przez Wisent w wyniku realizacji projektu',
  ];
  return known.find((name) => out.toLowerCase().startsWith(name.toLowerCase().slice(0, 55))) || out;
}

function fitProduct(product, functionality) {
  let out = clean(`${product}. Funkcjonalnie: ${functionality}. Punkt porównania: typ modelu, warstwa stosu AI, sposób wdrożenia, kontrola, audyt i zależność technologiczna UE.`);
  if (out.length < 190) {
    out = clean(`${out} Obejmuje produkt, funkcję użytkową, miejsce w łańcuchu wartości i zakres porównania z RNM.`);
  }
  if (out.length > 200) out = out.slice(0, 197).replace(/\s+\S*$/, '');
  if (!/[.!?]$/.test(out)) out += '.';
  return padNearLimit(out, 200, 190);
}

function fitFunctionality(functionality) {
  let out = clean(`${functionality}. Zakres porównania obejmuje funkcje użytkowe, sposób kontroli modelu, wdrożenie, audytowalność i zależność od dostawcy.`);
  if (out.length < 190) out = clean(`${out} Wskazuje, co użytkownik realnie otrzymuje w ofercie konkurenta.`);
  if (out.length > 200) out = out.slice(0, 197).replace(/\s+\S*$/, '');
  if (!/[.!?]$/.test(out)) out += '.';
  return padNearLimit(out, 200, 190);
}

function tableLines(rows) {
  return [
    '| Podmiot konkurencyjny | Kraj siedziby | Produkt / rozwiązanie | Funkcjonalności | Korzyść / przewaga RNM |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${r[0]} | ${r[1]} | ${fitProduct(r[2], r[3])} | ${fitFunctionality(r[3])} | ${fit(r[4], 1000)} |`),
  ].join('\n');
}

function parseTable(sectionTitle, nextTitle) {
  const start = md.indexOf(sectionTitle);
  const end = md.indexOf(nextTitle, start);
  if (start < 0 || end < 0) throw new Error(`table markers missing: ${sectionTitle}`);
  const rows = md.slice(start, end)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .map((line) => line.split('|').slice(1, -1).map(clean))
    .filter((cells) => cells.length === 5 && cells[0] !== 'Podmiot konkurencyjny');
  return { start, end, rows };
}

function rewriteTable(source, sectionTitle, nextTitle, rows) {
  const start = source.indexOf(sectionTitle);
  const end = source.indexOf(nextTitle, start);
  if (start < 0 || end < 0) throw new Error(`rewrite markers missing: ${sectionTitle}`);
  return source.slice(0, start + sectionTitle.length + 2) + tableLines(rows) + '\n\n' + source.slice(end);
}

function rowValue(block, label) {
  const line = block.split(/\r?\n/).find((l) => l.startsWith('|') && l.toLowerCase().includes(label.toLowerCase()));
  if (!line) throw new Error(`row missing: ${label}`);
  return clean(line.split('|').slice(1, -1)[1]);
}

function makeParamBlock(n, data) {
  return `### Parametr ${n}

| Pole | Wartość |
|---|---|
| Nazwa parametru | ${fitName(data.name)} |
| Wartość bazowa (z jednostką miary) | ${data.base} |
| Rok bazowy | ${data.baseYear || '2026'} |
| Wartość docelowa (z jednostką miary) | ${data.target} |
| Rok docelowy | ${data.targetYear || '2033'} |
| Metoda oszacowania wartości docelowej | ${fit(data.method, 1000)} |
| Sposób monitorowania / weryfikacji osiągnięcia zaplanowanych wartości docelowych | ${fit(data.verify, 800)} |`;
}

function parseParams(source) {
  const title = '## Parametry opisujące znaczący potencjał gospodarczy innowacji w wymiarze rynku wewnętrznego UE';
  const start = source.indexOf(title);
  if (start < 0) throw new Error('parameter section missing');
  const blocks = source.slice(start + title.length).split(/^### Parametr \d+\s*$/m).slice(1);
  const parsed = blocks.map((block) => ({
    name: rowValue(block, 'Nazwa parametru'),
    base: rowValue(block, 'Wartość bazowa'),
    baseYear: rowValue(block, 'Rok bazowy'),
    target: rowValue(block, 'Wartość docelowa'),
    targetYear: rowValue(block, 'Rok docelowy'),
    method: rowValue(block, 'Metoda oszacowania'),
    verify: rowValue(block, 'Sposób monitorowania'),
  }));
  return { title, start, parsed };
}

const eu = parseTable('## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE');
const nonEu = parseTable('## Oferta konkurencji spoza UE', '## Rynek docelowy dla innowacji produktowej');

let next = md;
next = rewriteTable(next, '## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE', eu.rows);
next = rewriteTable(next, '## Oferta konkurencji spoza UE', '## Rynek docelowy dla innowacji produktowej', nonEu.rows);

const params = parseParams(next);
const extra = [
  {
    name: 'Liczba odbiorców (klientów enterprise) korzystających z modeli RNM poza rynkiem wewnętrznym UE',
    base: '0 (odbiorcy)',
    target: '5 (odbiorcy)',
    method: 'Spójnie z wartością eksportu poza rynek wewnętrzny UE (3 mln PLN) i ceną 150 000 USD rocznie za klienta wdrożeniowego, przy kursie 4,00 USD/PLN, docelowa wartość odpowiada około pięciu aktywnym klientom spoza rynku wewnętrznego.',
    verify: 'Rejestr klientów z przypisanym krajem siedziby i oznaczeniem poza rynkiem wewnętrznym UE, faktury sprzedaży, umowy wdrożeniowe, billing API i zliczanie aktywnych płatnych klientów na koniec roku.',
  },
  {
    name: 'Wartość rocznych przychodów Wisent Polska ze sprzedaży modeli RNM poza rynek wewnętrzny UE',
    base: '0 PLN',
    target: '3 000 000 PLN',
    method: 'Ostrożne założenie 10% udziału eksportu poza rynek wewnętrzny UE w rocznym przychodzie z RNM, przy głównym priorytecie sprzedaży w UE: 10% × 30 000 000 PLN = 3 000 000 PLN.',
    verify: 'Faktury sprzedaży z podziałem geograficznym, rejestr klientów z krajem siedziby, ewidencja przychodów w księgach rachunkowych, umowy, billing API i roczne sprawozdania finansowe.',
  },
];

const extraNames = new Set(extra.map((p) => clean(p.name).toLowerCase()));
const extraPrefixes = extra.map((p) => clean(p.name).toLowerCase().slice(0, 80));
const dedupedParsed = params.parsed.filter((p) => {
  const name = clean(p.name).toLowerCase();
  return !extraNames.has(name) && !extraPrefixes.some((prefix) => name.startsWith(prefix));
});
const allParams = [...extra, ...dedupedParsed];
const paramSection = `${params.title}\n\n${allParams.map((p, i) => makeParamBlock(i + 1, p)).join('\n\n')}\n`;
next = next.slice(0, params.start) + paramSection;

writeFileSync(SRC, next);
console.log(JSON.stringify({
  ok: true,
  file: SRC,
  euRows: eu.rows.length,
  nonEuRows: nonEu.rows.length,
  params: allParams.length,
}, null, 2));
