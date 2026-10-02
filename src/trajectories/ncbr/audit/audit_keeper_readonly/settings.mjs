// The environment the read-only keeper audit runs with: the keeper socket, the project and
// its sections, and the credentials a login may need.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSION = process.env.SESSION || 'ncbr-step-b';
export const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
export const PROJECT_ID = (await import('#ncbr-settings')).projectId();
export const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
export const BASE = `${PROJECT_URL}/projekt_step/`;
export const OUT_DIR = process.env.OUT_DIR || (await import('#ncbr-settings')).applicationFile('audit_keeper_readonly');
export const EMAIL = process.env.NCBR_EMAIL || '';
export const PASSWORD = process.env.NCBR_PASSWORD || '';
delete process.env.NCBR_PASSWORD;

export const SECTIONS = [
  ['1.3', (await import('#ncbr-settings')).sectionId('1_3')],
  ['1.4', (await import('#ncbr-settings')).sectionId('1_4')],
  ['2.1', (await import('#ncbr-settings')).sectionId('2_1')],
  ['2.2', (await import('#ncbr-settings')).sectionId('2_2')],
  ['2.3', (await import('#ncbr-settings')).sectionId('2_3')],
  ['2.4', (await import('#ncbr-settings')).sectionId('2_4')],
  ['6.1', (await import('#ncbr-settings')).sectionId('6_1')],
  ['6.3', (await import('#ncbr-settings')).sectionId('6_3')],
  ['6.4', (await import('#ncbr-settings')).sectionId('6_4')],
  ['6.5', (await import('#ncbr-settings')).sectionId('6_5')],
  ['8', (await import('#ncbr-settings')).sectionId('8')],
  ['9.2', (await import('#ncbr-settings')).sectionId('9_2')],
  ['10.4', (await import('#ncbr-settings')).sectionId('10_4')],
];

mkdirSync(OUT_DIR, { recursive: true });
