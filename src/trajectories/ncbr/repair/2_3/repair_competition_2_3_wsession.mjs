// UI-only repair for 1.4 competitors and 2.3 competition/parameter tables.
// Adds only missing rows by reading visible LSI table text first. Never submits.

import { writeFileSync } from 'node:fs';
import { WSession } from '../../../../../dist/index.js';
import { humanIdlePause } from '../../../../../dist/human/mouse.js';
import { competitors14, euCompetition, nonEuCompetition, parameters23 } from './repair_competition_2_3_wsession/source.mjs';
import { lsiForm } from './repair_competition_2_3_wsession/form.mjs';
import { competitionSteps } from './repair_competition_2_3_wsession/steps.mjs';

const PROJECT_ID = process.env.NCBR_PROJECT_ID || '7ee80d9a-67dd-4d99-becd-8dda407221c1';
const PROJECT_URL = `https://lsi2.ncbr.gov.pl/projekt/${PROJECT_ID}`;
const BASE = `${PROJECT_URL}/projekt_step/`;
const URLS = {
  '1.4': `${BASE}4a6e9d5d-10e7-4436-8fd8-728a8e8b8ddc`,
  '2.3': `${BASE}c5dbdc83-5baf-4866-b3d8-4da3ae553865`,
};
const OUT = process.env.OUT || '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/competition_2_3_repair_evidence_20260624.json';

const email = process.env.NCBR_EMAIL;
const password = process.env.NCBR_PASSWORD;
if (!email || !password) {
  console.log(JSON.stringify({ error: 'MISSING_NCBR_CREDENTIALS' }, null, 2));
  process.exit(2);
}
delete process.env.NCBR_PASSWORD;

const session = await WSession.start({ label: 'ncbr_repair_competition_2_3_wsession', proxy: 'direct', browser: 'chromium' });
const page = session.page;
page.setDefaultTimeout(35000);

function progress(message) {
  console.log(`[repair_competition_2_3] ${new Date().toISOString()} ${message}`);
}

const form = lsiForm({ page, session, email, password, progress });
const { login, readSectionTables, visibleTableText, hasAnyName, clickDodaj } = form;
const {
  addCompetitor14, addCompetition23, dumpOpenFields, addParameter23, repairVisibleMissingNips14, validateProject,
} = competitionSteps({ page, progress, URLS, PROJECT_URL, ...form });

async function run() {
  const out = { parsed: { competitors14: competitors14.length, euCompetition: euCompetition.length, nonEuCompetition: nonEuCompetition.length, parameters23: parameters23.length }, actions: [] };
  progress(`parsed:${JSON.stringify(out.parsed)}`);
  await login();

  if (process.env.REPAIR_14_NIPS === '1') {
    out.repairedNips14 = await repairVisibleMissingNips14();
    out.readback = { '1.4': await readSectionTables(URLS['1.4']) };
    if (process.env.VALIDATE === '1') out.validation = await validateProject();
    writeFileSync(OUT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify({ out: OUT, parsed: out.parsed, repairedNips14: out.repairedNips14, readback: out.readback, validation: out.validation || null }, null, 2));
    await session.ctx.close();
    return;
  }

  if (process.env.DIAG_PARAM === '1') {
    await page.goto(URLS['2.3'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 2.3 diagnostic navigation
    await humanIdlePause('long');
    await clickDodaj(2);
    out.diagParamFields = await dumpOpenFields();
    console.log(JSON.stringify(out, null, 2));
    await session.ctx.close();
    return;
  }

  await page.goto(URLS['1.4'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 1.4 navigation
  progress('section:1.4');
  await humanIdlePause('long');
  for (const row of competitors14) {
    const current = await visibleTableText();
    if (hasAnyName(current, row)) {
      progress(`1.4:skip:${row.name}`);
      out.actions.push({ section: '1.4', skippedExisting: row.name });
      continue;
    }
    out.actions.push({ section: '1.4', ...(await addCompetitor14(row)) });
  }

  await page.goto(URLS['2.3'], { waitUntil: 'domcontentloaded', timeout: 120000 }); // allow-raw-playwright: section 2.3 navigation
  progress('section:2.3');
  await humanIdlePause('long');
  for (const row of euCompetition) {
    const current = await visibleTableText();
    if (current.includes(row.producer)) {
      progress(`2.3:skip-competition:${row.producer}`);
      out.actions.push({ section: '2.3 UE', skippedExisting: row.producer });
      continue;
    }
    out.actions.push({ section: '2.3 UE', ...(await addCompetition23(0, row)) });
  }
  for (const row of nonEuCompetition) {
    const current = await visibleTableText();
    if (current.includes(row.producer)) {
      progress(`2.3:skip-competition:${row.producer}`);
      out.actions.push({ section: '2.3 nonUE', skippedExisting: row.producer });
      continue;
    }
    out.actions.push({ section: '2.3 nonUE', ...(await addCompetition23(1, row)) });
  }
  for (const row of parameters23) {
    const current = await visibleTableText();
    if (current.includes(row.name)) {
      progress(`2.3:skip-parameter:${row.name}`);
      out.actions.push({ section: '2.3 parametry', skippedExisting: row.name });
      continue;
    }
    out.actions.push({ section: '2.3 parametry', ...(await addParameter23(row)) });
  }

  out.readback = {
    '1.4': await readSectionTables(URLS['1.4']),
    '2.3': await readSectionTables(URLS['2.3']),
  };
  if (process.env.VALIDATE === '1') out.validation = await validateProject();
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ out: OUT, parsed: out.parsed, actions: out.actions.map((a) => ({ section: a.section, added: a.added, skippedExisting: a.skippedExisting })), readback: out.readback, validation: out.validation || null }, null, 2));
  await session.ctx.close();
}

await run();
process.exit(0);
