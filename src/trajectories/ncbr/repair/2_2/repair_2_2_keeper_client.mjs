// Targeted repair for section 2.2 in the replacement NCBR STEP B draft.
// Uses the existing keeper session. Does not start/close the browser and never submits.

import { writeFileSync } from 'node:fs';
import { OUT, SECTION_URL } from './repair_2_2_keeper_client/source.mjs';
import { ALL_FACTORS, EXTRA_FEATURES, FACTOR_ROWS } from './repair_2_2_keeper_client/rows.mjs';
import { action, nav } from './repair_2_2_keeper_client/keeper.mjs';
import {
  addFactorRow, addFeature, ensureFactorSelected, evidence, loginIfNeeded, readState, saveMain, setMainTexts,
} from './repair_2_2_keeper_client/steps.mjs';

loginIfNeeded();
nav(SECTION_URL);
evidence.steps.push({ step: 'before', state: readState() });
setMainTexts();
nav(SECTION_URL);
const factorSelections = ALL_FACTORS.map((label) => ensureFactorSelected(label));
action(['humanidle', 'long'], 60000, true);
const factorSave = saveMain();
evidence.steps.push({ step: 'factor_multiselect', factorSelections, save: factorSave });

if (process.env.ONLY_MAIN === '1') {
  nav(SECTION_URL);
  evidence.readback = readState();
  evidence.finishedAt = new Date().toISOString();
  writeFileSync(OUT, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({
    ok: true,
    out: OUT,
    mode: 'ONLY_MAIN',
    lengths: evidence.sourceLengths,
    chips: evidence.readback.chips,
    tables: evidence.readback.tables.map((t) => ({ i: t.i, rows: t.rows, sample: t.text.slice(0, 240) })),
    fields: evidence.readback.fields.filter((f) => /opis_rezultatu|wplyw_rezultatu/.test(f.name)).map((f) => ({ name: f.name.split('.').at(-1), len: f.len, max: f.max, suffix: f.suffix.slice(-80) })),
  }, null, 2));
  process.exit(0);
}

const features = EXTRA_FEATURES.map(addFeature);
evidence.steps.push({ step: 'extra_features', features });

const factorRows = FACTOR_ROWS.map(addFactorRow);
evidence.steps.push({ step: 'factor_rows', factorRows });

nav(SECTION_URL);
evidence.readback = readState();
evidence.screenshot = action(['screenshot'], 120000, true);
evidence.finishedAt = new Date().toISOString();
writeFileSync(OUT, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({
  ok: true,
  out: OUT,
  lengths: evidence.sourceLengths,
  chips: evidence.readback.chips,
  tables: evidence.readback.tables.map((t) => ({ i: t.i, rows: t.rows, sample: t.text.slice(0, 240) })),
  fields: evidence.readback.fields.filter((f) => /opis_rezultatu|wplyw_rezultatu/.test(f.name)).map((f) => ({ name: f.name.split('.').at(-1), len: f.len, max: f.max, suffix: f.suffix.slice(-80) })),
  screenshot: evidence.screenshot?.path,
}, null, 2));
