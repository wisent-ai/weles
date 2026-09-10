import { readFileSync } from 'node:fs';

const SRC = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.3_rynek_i_potencjal.md';
const text = readFileSync(SRC, 'utf8');

function section(start, end) {
  const a = text.indexOf(start);
  if (a < 0) throw new Error(`missing marker: ${start}`);
  const b = end ? text.indexOf(end, a + start.length) : text.length;
  if (end && b < 0) throw new Error(`missing marker: ${end}`);
  return text.slice(a, b);
}

function countRows(block) {
  return block.split('\n').filter((line) => {
    const t = line.trim();
    return t.startsWith('|') && !t.includes('---') && !/^\|\s*Podmiot/.test(t) && !/^\|\s*Pole\s*\|/.test(t);
  }).length;
}

function cellEndFindings(blockName, block) {
  const findings = [];
  const rows = block.split('\n').filter((line) => line.trim().startsWith('|') && !line.includes('---'));
  for (const [lineIndex, line] of rows.entries()) {
    if (/^\|\s*(Podmiot|Pole)\b/.test(line.trim())) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim()).filter(Boolean);
    for (const [cellIndex, cell] of cells.entries()) {
      if (cell.length < 70) continue;
      const suffix = cell.slice(-160);
      const finalSentence = (cell.match(/[^.!?]+[.!?]$/) || [''])[0].trim();
      const dangling = /\b(?:do|dla|od|na|w|we|z|ze|oraz|i|ani|który|która|które|jako|przez|po|bez|nad|pod|między|wobec|według|związku|zakresie)$/i.test(cell.replace(/[.!?]\s*$/, '').trim());
      const tinyFinalSentence = finalSentence && finalSentence.length < 28 && cell.length > 180;
      if (dangling || tinyFinalSentence) {
        findings.push({
          block: blockName,
          line: lineIndex + 1,
          cell: cellIndex + 1,
          len: cell.length,
          dangling,
          tinyFinalSentence,
          suffix,
        });
      }
    }
  }
  return findings;
}

const eu = section('## Oferta konkurencji wewnątrz UE', '## Oferta konkurencji spoza UE');
const nonEu = section('## Oferta konkurencji spoza UE', '## Rynek docelowy dla innowacji produktowej');
const params = section('## Parametry opisujące znaczący potencjał gospodarczy', null);

const normalized = text.replace(/\s+/g, ' ');
const sentences = (normalized.match(/[^.!?]{45,}[.!?]/g) || [])
  .map((s) => s.trim())
  .filter((s) => !s.startsWith('|'));
const counts = new Map();
for (const s of sentences) counts.set(s, (counts.get(s) || 0) + 1);
const repeatedSentences = [...counts.entries()]
  .filter(([, count]) => count > 1)
  .map(([sentence, count]) => ({ count, sentence }))
  .sort((a, b) => b.count - a.count || b.sentence.length - a.sentence.length);

const bannedPhrases = [
  'Nie chodzi wyłącznie o lepszy wynik benchmarku',
  'Porównanie odnosi się do produktu',
  'Definicja wskaźnika obejmuje',
  'Weryfikacja obejmuje źródło danych',
  'Dowód: umowa',
  'Wzmacnia to nadzór',
];
const banned = Object.fromEntries(bannedPhrases.map((p) => [p, (text.match(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length]));
const cellEndings = [
  ...cellEndFindings('eu', eu),
  ...cellEndFindings('nonEu', nonEu),
  ...cellEndFindings('params', params),
];

console.log(JSON.stringify({
  file: SRC,
  rows: {
    eu: countRows(eu),
    nonEu: countRows(nonEu),
    params: countRows(params),
  },
  repeatedSentenceCount: repeatedSentences.length,
  repeatedSentences: repeatedSentences.slice(0, 20),
  cellEndingFindingCount: cellEndings.length,
  cellEndings: cellEndings.slice(0, 80),
  banned,
}, null, 2));
