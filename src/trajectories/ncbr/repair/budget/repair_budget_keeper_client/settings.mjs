// The environment the budget repair runs with: the keeper socket, the project and its
// section addresses, the credentials a login may need, and the evidence it collects.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSION = process.env.SESSION || 'ncbr-step-b';
export const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
export const PROJECT_ID = (await import('#ncbr-settings')).projectId();
export const BASE = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}/projekt_step/`;
export const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
export const URLS = {
  s22: (await import('#ncbr-settings')).sectionUrl('2_2'),
  s63: (await import('#ncbr-settings')).sectionUrl('6_3'),
  s65: (await import('#ncbr-settings')).sectionUrl('6_5'),
  s8: (await import('#ncbr-settings')).sectionUrl('8'),
};

export const email = process.env.NCBR_EMAIL;
if (!email) throw new Error('NCBR_EMAIL missing');
export const password = process.env.NCBR_PASSWORD;
if (!password) throw new Error('NCBR_PASSWORD missing');
delete process.env.NCBR_PASSWORD;

export const evidence = {
  startedAt: new Date().toISOString(),
  session: SESSION,
  project: PROJECT_ID,
  steps: [],
};
