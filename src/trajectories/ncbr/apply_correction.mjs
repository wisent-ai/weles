// Apply, verify or inspect a declared correction through the existing LSI2 UI.
// NCBR_CORRECTION_PLAN_FILE selects JSON; NCBR_CORRECTION_MODE defaults to verify.
// REPORT_DIR retains complete before/expected/actual values and screenshots.
// Never edits reviewer recommendations, uploads attachments or submits an application.
import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { loadPlan } from './correction/plan.mjs';
import { fillPrepared, nestedFields, oneField, prepareFields, snapshotFields, verifyPrepared } from './correction/fields.mjs';
import { closeDrawer, gotoSafe, identity, openRow, openScope, save } from './correction/ui.mjs';

const { plan, mode, projectUrl, planSha256 } = loadPlan();
const endpoint = process.env.NCBR_CDP_ENDPOINT || 'http://127.0.0.1:9223';
const runId = process.env.WELES_RUN_ID || `ncbr-correction-${new Date().toISOString().replace(/[:.]/g, '-')}`;
process.env.WELES_RUN_ID = runId;
const reportDir = process.env.REPORT_DIR || runRecordingsDir(`ncbr_${mode}_correction`);
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, 'correction-report.json');
const results = [];
const report = {
  schema: 'weles.ncbr.correction-report.v1', runId, mode, projectId: plan.project.id,
  applicationNumber: plan.project.applicationNumber, planSha256,
  sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  startedAt: new Date().toISOString(), submissionClicked: false, results,
};
const retain = (status, error) => {
  Object.assign(report, { status, error: error ? String(error.message || error) : null });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
};
const scopeFilter = process.env.SECTION;
const selected = (scope) => !scopeFilter || scope.label === scopeFilter;
let page;
try {
  const browser = await chromium.connectOverCDP(endpoint);
  page = browser.contexts()[0]?.pages().find((candidate) => candidate.url().startsWith(projectUrl));
  if (!page) throw new Error('No existing browser page belongs to the declared project');
  report.identity = await identity(page, projectUrl, plan.project);
  retain('inspecting');
  for (const section of plan.sections.filter(selected)) {
    await openScope(page, section, projectUrl);
    const result = { scope: section.label, beforeFields: await snapshotFields(page) };
    results.push(result);
    if (mode === 'inspect') { retain('inspecting'); continue; }
    result.fields = await prepareFields(page, section.fields, plan, section.label);
    retain('prepared');
    if (mode === 'apply' && result.fields.some((field) => field.before !== field.expected)) {
      await fillPrepared(page, result.fields);
      await save(page, false, result.fields, section.saveButton || null);
    }
    await openScope(page, section, projectUrl);
    await verifyPrepared(page, result.fields);
    result.afterFields = await snapshotFields(page);
    result.screenshot = join(reportDir, `section-${section.label.replace(/[^a-z0-9.-]/gi, '_')}.png`);
    await page.screenshot({ path: result.screenshot, fullPage: true });
    retain('verified');
  }
  for (const collection of plan.collections.filter(selected)) {
    for (const row of collection.rows) {
      await openRow(page, collection, row, projectUrl);
      const result = { scope: collection.label, rowNeedle: row.rowNeedle, beforeFields: await snapshotFields(page) };
      results.push(result);
      if (mode === 'inspect') { await closeDrawer(page); retain('inspecting'); continue; }
      result.fields = await prepareFields(page, await nestedFields(page, row), plan, collection.label);
      retain('prepared');
      const choices = result.fields.filter((field) => field.control && field.before !== field.expected);
      const texts = result.fields.filter((field) => !field.control);
      if (mode === 'apply' && choices.length) {
        await fillPrepared(page, choices);
        await save(page, true, choices);
        await openRow(page, collection, row, projectUrl);
        for (const field of texts) field.before = await (await oneField(page, field.name)).inputValue();
      }
      const changedTexts = mode === 'apply' ? texts.filter((field) => field.before !== field.expected) : [];
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
  }
  if (!results.length) throw new Error('The requested scope selected no sections or rows');
  report.finalIdentity = await identity(page, projectUrl, plan.project);
  report.finishedAt = new Date().toISOString();
  retain('complete');
  console.log(JSON.stringify({ status: report.status, mode, reportPath,
    results: results.map((result) => ({ scope: result.scope, rowNeedle: result.rowNeedle,
      fields: result.fields?.map(({ name, persisted, sha256 }) => ({ name, persisted, sha256 })) })) }, null, 2));
} catch (error) {
  if (page) {
    report.failedUrl = page.url();
    report.failureScreenshot = join(reportDir, 'failure.png');
    try { await page.screenshot({ path: report.failureScreenshot, fullPage: true }); }
    catch (captureError) { report.failureScreenshotError = String(captureError.message || captureError); }
  }
  retain('failed', error);
  console.error(JSON.stringify({ status: report.status, error: report.error, reportPath }, null, 2));
  process.exitCode = 1;
}
process.exit(process.exitCode || 0);
