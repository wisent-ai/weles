// The environment the read-only keeper audit runs with: the keeper socket, the project and
// its sections, and the credentials a login may need.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SESSION = process.env.SESSION || 'ncbr-step-b';
export const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
export const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
export const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
export const BASE = `${PROJECT_URL}/projekt_step/`;
export const OUT_DIR = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/audit_keeper_readonly_20260625';
export const EMAIL = process.env.NCBR_EMAIL || '';
export const PASSWORD = process.env.NCBR_PASSWORD || '';
delete process.env.NCBR_PASSWORD;

export const SECTIONS = [
  ['1.3', '317a21dd-e798-4115-ab53-6ab5a2912fb0'],
  ['1.4', '4a6e9d5d-10e7-4436-8fd8-728a8e8b8ddc'],
  ['2.1', 'c048ab30-3dda-4228-bf71-4ec6904cffda'],
  ['2.2', '80ebca16-a9dd-4798-a334-5ac007cecbf7'],
  ['2.3', 'c5dbdc83-5baf-4866-b3d8-4da3ae553865'],
  ['2.4', '94fb1adb-38a5-4949-b4c1-b0a79472bfd3'],
  ['6.1', '566c735c-8ad0-406f-a948-f3ea921c2cc7'],
  ['6.3', 'fb417879-403e-4241-a202-ec23c6a6b866'],
  ['6.4', '7f63b840-57b3-4e73-9fb0-91c6f24cad44'],
  ['6.5', 'bdb2c7b3-92d9-4778-9ecc-b4c5bda7d32b'],
  ['8', 'd31b6d68-33b7-45a0-a032-0f5f02b5aed8'],
  ['9.2', 'e95d0c23-8a39-4d56-96fa-ace3e4f0d23a'],
  ['10.4', '4e260fae-c455-41ce-bba3-d0df2a8767fd'],
];

mkdirSync(OUT_DIR, { recursive: true });
