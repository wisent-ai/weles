// UI-only repair for section 1.3 contacts/e-Doreczenia and section 2.2 collections.
// Never submits, never uploads documents, never uses LSI direct APIs.

import { writeFileSync } from 'node:fs';
import { WSession } from '../../../../../dist/index.js';
import { FACTORS, FEATURES } from './repair_contacts_2_2_wsession/source.mjs';
import { lsiForm } from './repair_contacts_2_2_wsession/form.mjs';
import { contactRepairs } from './repair_contacts_2_2_wsession/sections.mjs';

const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const URLS = {
  '1.3': `${BASE}317a21dd-e798-4115-ab53-6ab5a2912fb0`,
  '2.2': `${BASE}80ebca16-a9dd-4798-a334-5ac007cecbf7`,
};
const OUT = process.env.OUT || '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/contacts_2_2_repair_evidence_20260624.json';
const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;
if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;


const session = await WSession.start({ label: 'ncbr_repair_contacts_2_2_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(35000);

function progress(message) {
  console.log(`[repair_contacts_2_2] ${new Date().toISOString()} ${message}`);
}

const form = lsiForm({ page, session, email, password, progress });
const { login } = form;
const { diag13, diag13Edit, diag13ContactEdit, repair13, repair22, readTables } = contactRepairs({ page, email, progress, URLS, ...form });

await login();
const out = { parsed: { features: FEATURES.length, factors: FACTORS.length }, actions: {} };
if (process.env.DIAG_13 === '1') {
  out.diag13 = await diag13();
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ out: OUT, diag13: out.diag13 }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.DIAG_13_EDIT === '1') {
  out.diag13Edit = await diag13Edit();
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ out: OUT, diag13Edit: out.diag13Edit }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
if (process.env.DIAG_13_CONTACT_EDIT === '1') {
  out.diag13ContactEdit = await diag13ContactEdit();
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ out: OUT, diag13ContactEdit: out.diag13ContactEdit }, null, 2));
  await session.ctx.close();
  process.exit(0);
}
out.actions['1.3'] = await repair13();
out.actions['2.2'] = await repair22();
writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ out: OUT, parsed: out.parsed, readback: { '1.3': out.actions['1.3'].readback, '2.2': out.actions['2.2'].readback } }, null, 2));
await session.ctx.close();
process.exit(0);
