// The environment the budget repair runs with: the keeper socket, the project and its
// section addresses, the credentials a login may need, and the evidence it collects.
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSION = process.env.SESSION || 'ncbr-step-b';
export const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
export const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
export const BASE = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}/projekt_step/`;
export const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
export const URLS = {
  s22: `${BASE}80ebca16-a9dd-4798-a334-5ac007cecbf7`,
  s63: `${BASE}fb417879-403e-4241-a202-ec23c6a6b866`,
  s65: `${BASE}bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b`,
  s8: `${BASE}d31b6d68-33b7-45a0-a032-0f5f02b5aed8`,
};

export const email = process.env.NCBR_EMAIL || 'lukasz.bartoszcze@gmail.com';
export const password = process.env.NCBR_PASSWORD;
if (!password) throw new Error('NCBR_PASSWORD missing');
delete process.env.NCBR_PASSWORD;

export const evidence = { startedAt: new Date().toISOString(), session: SESSION, project: PROJECT_ID, steps: [] };
