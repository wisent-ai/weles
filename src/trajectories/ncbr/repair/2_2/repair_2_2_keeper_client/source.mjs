// The environment the 2.2 repair runs with, and the three section texts it carries,
// read from the application's markdown source and checked against the field limits.
import { readFileSync } from 'node:fs';


export const SESSION = process.env.SESSION || 'ncbr-step-b';
export const WELES = new URL('../../../../../..', import.meta.url).pathname.replace(/\/$/, '');
export const PROJECT_ID = (await import('#ncbr-settings')).projectId();
export const SECTION_URL = (await import('#ncbr-settings')).sectionUrl('2_2');
export const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
export const SRC = (await import('#ncbr-settings')).applicationFile('wersja_B_2.2_innowacyjnosc_i_zaleznosci.md');
export const OUT = (await import('#ncbr-settings')).applicationFile('repair_2_2_evidence_20260625.json');

export const EMAIL = process.env.NCBR_EMAIL || '';
export const PASSWORD = process.env.NCBR_PASSWORD || '';
delete process.env.NCBR_PASSWORD;

export const md = readFileSync(SRC, 'utf8');
export const clean = (s) => String(s || '').replace(/\s*<!--[\s\S]*?-->\s*/g, ' ').trim();
export const squeeze = (s) => clean(s).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');

function sectionBetween(start, end) {
  const a = md.indexOf(start);
  if (a < 0) throw new Error(`missing source marker: ${start}`);
  const b = end ? md.indexOf(end, a + start.length) : -1;
  return squeeze(md.slice(a + start.length, b >= 0 ? b : md.length));
}

export let OPIS = sectionBetween('## Opis rezultatu prac B+R', '## Podsumowanie cech');
if (OPIS.length > 12000) throw new Error(`OPIS over limit: ${OPIS.length}/12000`);

export let WPLYW = sectionBetween('## Wpływ rezultatu prac B+R na ograniczanie lub zwalczanie strategicznej zależności Unii', '## Podsumowanie wpływu prac B+R na ograniczanie');
if (WPLYW.length > 6000) throw new Error(`WPLYW over limit: ${WPLYW.length}/6000`);

export let POWIAZANIE = sectionBetween('## Powiązanie rezultatu prac B+R z łańcuchem wartości konkretnej technologii krytycznej', null).split('\n\n')[0].trim();
if (POWIAZANIE.length > 4000) throw new Error(`POWIAZANIE over limit: ${POWIAZANIE.length}/4000`);
