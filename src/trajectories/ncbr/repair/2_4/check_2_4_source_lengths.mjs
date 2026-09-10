import { readFileSync } from 'node:fs';

const SRC = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_2.4_efekty_zewnetrzne.md';
const md = readFileSync(SRC, 'utf8');
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function rowValue(block, label) {
  const line = block.split(/\r?\n/).find((l) => l.startsWith('|') && l.toLowerCase().includes(label.toLowerCase()));
  if (!line) throw new Error(`row missing: ${label}`);
  return clean(line.split('|').slice(1, -1)[1]);
}

const title = '## Parametry opisujące dodatkowe efekty zewnętrzne innowacji';
const start = md.indexOf(title);
if (start < 0) throw new Error('parameter section missing');

const rows = md.slice(start + title.length)
  .split(/^### Parametr \d+\s*$/m)
  .slice(1)
  .map((block) => {
    const name = rowValue(block, 'Nazwa parametru');
    const method = rowValue(block, 'Metoda oszacowania');
    const verify = rowValue(block, 'Sposób monitorowania');
    return {
      nameHead: name.slice(0, 90),
      name: name.length,
      method: method.length,
      verify: verify.length,
      nameShortBy: 500 - name.length,
      methodShortBy: 1000 - method.length,
      verifyShortBy: 1000 - verify.length,
    };
  });

console.log(JSON.stringify({ rows }, null, 2));
