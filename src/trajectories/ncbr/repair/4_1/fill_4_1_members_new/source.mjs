// The section 4.1 team members, parsed from the application's markdown source.
import { readFileSync } from 'node:fs';

const MD = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/wersja_B_4_1_zespol.md';
const md = readFileSync(MD, 'utf8');

function extract(block, label) {
  const lines = block.split(/\r?\n/);
  const norm = (s) => s.trim().replace(/^\*\*/, '').replace(/\*\*$/, '').replace(/:$/, '').trim();
  const start = lines.findIndex((line) => norm(line) === label);
  if (start < 0) return '';
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^\*\*.+\*\*$/.test(t) || /^#{2,4}\s/.test(t) || t === '---') break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

export function members() {
  return md.split(/^## Zespół projektowy — członek \d+\s*$/m).slice(1).map((b) => ({
    imie: extract(b, 'Imię'),
    nazwisko: extract(b, 'Nazwisko'),
    wyksztalcenie: extract(b, 'Wykształcenie'),
    tytul: extract(b, 'Tytuł naukowy/stopień naukowy (jeśli dotyczy)'),
    rola: extract(b, 'Rola w projekcie'),
    doswiadczenie: extract(b, 'Doświadczenie naukowe i zawodowe oraz doświadczenie we wdrażaniu wyników prac B+R'),
    stanowisko: extract(b, 'Stanowisko i zakres obowiązków w projekcie'),
    wymiar: extract(b, 'Wymiar zaangażowania w projekcie'),
    status: extract(b, 'Status współpracy'),
    podmiot: extract(b, 'Nazwa skrócona podmiotu'),
    projects: b.split(/^### Informacje o zrealizowanych projektach.*$/m).slice(1).map((p) => ({
      tytul: extract(p, 'Tytuł projektu'),
      budzet: extract(p, 'Budżet (PLN)'),
      numer: extract(p, 'Numer projektu'),
      od: extract(p, 'Okres realizacji od'),
      do: extract(p, 'Okres realizacji do'),
      konsorcjum: extract(p, 'Projekt realizowany w ramach konsorcjum') || 'Nie',
      rola: extract(p, 'Rola w zrealizowanym projekcie'),
      efekty: extract(p, 'Główne efekty zrealizowanego projektu'),
    })).filter((p) => p.tytul),
  })).filter((m) => m.imie && m.nazwisko);
}
