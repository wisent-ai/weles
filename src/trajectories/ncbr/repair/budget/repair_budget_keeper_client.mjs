// Keeper-socket repair client for the replacement NCBR STEP B draft.
// Uses one existing Weles keeper session. No host cursor, no visible browser restart,
// no LSI direct write API, and never invokes submission.

import { writeFileSync } from 'node:fs';
import { URLS, evidence } from './repair_budget_keeper_client/settings.mjs';
import { DIRECT_ROWS, INDIRECT_ROWS } from './repair_budget_keeper_client/rows.mjs';
import { loginIfNeeded, repair22Factor, repair8, repairRows, validate } from './repair_budget_keeper_client/repairs.mjs';

await loginIfNeeded();
await repair22Factor();
await repairRows('6.3_direct_rows', URLS.s63, DIRECT_ROWS);
await repairRows('6.5_indirect_rows', URLS.s65, INDIRECT_ROWS);
await repair8();
await validate();

evidence.finishedAt = new Date().toISOString();
const outPath = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/backends/STEP_sciezka_A_Wisent/keeper_budget_repair_evidence_20260624.json';
writeFileSync(outPath, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ok: true, outPath, lastStep: evidence.steps.at(-1) }, null, 2));
