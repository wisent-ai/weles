// The section 6.1 tasks and their milestones, parsed from the application's markdown source.
import { readFileSync } from 'node:fs';

const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_6_harmonogram.md';
export const md = readFileSync(MD, 'utf8');

function extract(block, label) {
  const lines = block.split(/\r?\n/);
  const norm = (s) => s.trim().replace(/\*\*/g, '').replace(/:$/, '').trim();
  const start = lines.findIndex((line) => norm(line) === label || norm(line).startsWith(`${label}:`));
  if (start < 0) return '';
  const inline = norm(lines[start]);
  if (inline.startsWith(`${label}:`)) {
    const value = inline.slice(label.length + 1).trim();
    if (value) return value;
  }
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^\*\*.+\*\*$/.test(t) || /^#{2,4}\s/.test(t) || t === '---') break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function milestones(block) {
  return block.split(/^#### Kamień milowy \d+\.\d+\s*$/m).slice(1).map((b) => ({
    nazwa: extract(b, 'Nazwa kamienia milowego'),
    parametry: extract(b, 'Parametry'),
    weryfikacja: extract(b, 'Opis sposobu weryfikacji osiągnięcia kamienia milowego'),
    wplyw: extract(b, 'Opis wpływu nieosiągnięcia kamienia na realizację projektu'),
  })).filter((m) => m.nazwa);
}

export function tasks() {
  const headings = Array.from(md.matchAll(/^### Zadanie\s+(\d+)\.[^\n]*$/gm));
  return headings.map((match, index) => {
    const next = headings[index + 1];
    const b = md.slice(match.index + match[0].length, next ? next.index : md.length);
    return ({
    nr: extract(b, 'Nr zadania'),
    nazwaRodzaj: extract(b, 'Nazwa i rodzaj zadania'),
    nazwa: extract(b, 'Nazwa zadania'),
    koszty: extract(b, 'Koszty pośrednie'),
    start: extract(b, 'Data rozpoczęcia'),
    end: extract(b, 'Data zakończenia'),
    rodzaj: extract(b, 'Rodzaj zadania'),
    podmiot: extract(b, 'Nazwa skrócona podmiotu'),
    zakres: extract(b, 'Zakres planowanych prac B+R'),
    szczegolowy: extract(b, 'Szczegółowy opis planowanych prac wraz z uzasadnieniem (w tym opis metody badawczej)'),
    milestones: milestones(b),
    });
  }).filter((t) => t.nr || t.nazwa);
}
