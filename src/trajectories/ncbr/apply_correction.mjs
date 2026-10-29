// Apply, verify or inspect a declared correction through the existing LSI2 UI.
// NCBR_CORRECTION_PLAN_FILE selects JSON; NCBR_CORRECTION_MODE states apply, verify or inspect.
// The run's recordings directory retains complete before/expected/actual values and screenshots.
// Never edits reviewer recommendations, uploads attachments or submits an application.
// The run attaches to the signed-in browser over DevTools and detaches at the
// end without closing it; a failure is recorded in the report and ends the
// run through its exit status.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { exitStatusFor } from '../../../dist/cli/usage.js';
import {
  runId,
  runRecordingsDir,
} from '../../../dist/session/run-recordings.js';
import { projectPage } from '../_shared/ncbr/project_page.mjs';
import { loadPlan } from './correction/plan.mjs';
import {
  fillPrepared,
  nestedFields,
  oneField,
  prepareFields,
  snapshotFields,
  verifyPrepared,
} from './correction/fields.mjs';
import {
  closeDrawer,
  identity,
  openRow,
  openScope,
  save,
} from './correction/ui.mjs';

const { plan, mode, projectUrl, planSha256 } = loadPlan();
const endpoint = (await import('#ncbr-settings')).cdpEndpoint();
// The run's recordings directory is named by the same id the report carries.
const reportDir = runRecordingsDir(`ncbr_${mode}_correction`);
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, 'correction-report.json');
const results = [];
const report = {
  schema: 'weles.ncbr.correction-report.v1',
  runId: runId(),
  mode,
  projectId: plan.project.id,
  applicationNumber: plan.project.applicationNumber,
  planSha256,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim(),
  startedAt: new Date().toISOString(),
  submissionClicked: false,
  results,
};
const retain = (status, error) => {
  Object.assign(report, { status, error: error ? error.message : null });
  writeFileSync(reportPath, `${JSON.stringify(report, null, ' ')}\n`);
};
const scopeFilter = process.env.SECTION;
const selected = (scope) => !scopeFilter || scope.label === scopeFilter;

async function correctSection(page, section) {
  await openScope(page, section, projectUrl);
  const result = {
    scope: section.label,
    beforeFields: await snapshotFields(page),
  };
  results.push(result);
  if (mode === 'inspect') {
    retain('inspecting');
    return;
  }
  result.fields = await prepareFields(
    page,
    section.fields,
    plan,
    section.label,
  );
  retain('prepared');
  // LSI2 drops text typed into a second field before the first is saved; save every changed field separately.
  const changed =
    mode === 'apply'
      ? result.fields.filter((field) => field.before !== field.expected)
      : [];
  for (const [index, field] of changed.entries()) {
    if (index) await openScope(page, section, projectUrl);
    await fillPrepared(page, [field]);
    await save(page, false, [field], section.saveButton);
  }
  await openScope(page, section, projectUrl);
  await verifyPrepared(page, result.fields);
  result.afterFields = await snapshotFields(page);
  result.screenshot = join(
    reportDir,
    `section-${section.label.replace(/[^a-z0-9.-]/gi, '_')}.png`,
  );
  await page.screenshot({ path: result.screenshot, fullPage: true });
  retain('verified');
}

async function correctRow(page, collection, row) {
  await openRow(page, collection, row, projectUrl);
  const result = {
    scope: collection.label,
    rowSubject: row.rowSubject,
    beforeFields: await snapshotFields(page),
  };
  results.push(result);
  if (mode === 'inspect') {
    await closeDrawer(page);
    retain('inspecting');
    return;
  }
  result.fields = await prepareFields(
    page,
    await nestedFields(page, row),
    plan,
    collection.label,
  );
  retain('prepared');
  const choices = result.fields.filter(
    (field) => field.control && field.before !== field.expected,
  );
  const texts = result.fields.filter((field) => !field.control);
  if (mode === 'apply' && choices.length) {
    await fillPrepared(page, choices);
    await save(page, true, choices);
    await openRow(page, collection, row, projectUrl);
    for (const field of texts)
      field.before = await (await oneField(page, field.name)).inputValue();
  }
  const changedTexts =
    mode === 'apply'
      ? texts.filter((field) => field.before !== field.expected)
      : [];
  if (!changedTexts.length) await closeDrawer(page);
  for (const [index, field] of changedTexts.entries()) {
    if (index) await openRow(page, collection, row, projectUrl);
    await fillPrepared(page, [field]);
    await save(page, true, [field]);
  }
  await openRow(page, collection, row, projectUrl);
  await verifyPrepared(page, result.fields);
  result.afterFields = await snapshotFields(page);
  result.screenshot = join(reportDir, `row-${results.length}.png`);
  await page.screenshot({ path: result.screenshot, fullPage: true });
  await closeDrawer(page);
  retain('verified');
}

async function recordFailure(page, error) {
  if (page) {
    report.failedUrl = page.url();
    report.failureScreenshot = join(reportDir, 'failure.png');
    try {
      await page.screenshot({ path: report.failureScreenshot, fullPage: true });
    } catch (captureError) {
      report.failureScreenshotError = captureError.message;
    }
  }
  retain('failed', error);
  console.error(
    JSON.stringify(
      { status: report.status, error: report.error, reportPath },
      null,
      ' ',
    ),
  );
}

const browser = await chromium.connectOverCDP(endpoint);
let page;
try {
  page = projectPage(browser, projectUrl);
  report.identity = await identity(page, projectUrl, plan.project);
  retain('inspecting');
  for (const section of plan.sections.filter(selected))
    await correctSection(page, section);
  for (const collection of plan.collections.filter(selected))
    for (const row of collection.rows) await correctRow(page, collection, row);
  if (!results.length)
    throw new Error('The requested scope selected no sections or rows');
  report.finalIdentity = await identity(page, projectUrl, plan.project);
  report.finishedAt = new Date().toISOString();
  retain('complete');
  console.log(
    JSON.stringify(
      {
        status: report.status,
        mode,
        reportPath,
        results: results.map((result) => ({
          scope: result.scope,
          rowSubject: result.rowSubject,
          fields: result.fields?.map(({ name, persisted, sha256 }) => ({
            name,
            persisted,
            sha256,
          })),
        })),
      },
      null,
      ' ',
    ),
  );
} catch (error) {
  await recordFailure(page, error);
  process.exitCode = exitStatusFor(error);
} finally {
  // Detaches from the signed-in browser; its pages stay open.
  await browser.close();
}
