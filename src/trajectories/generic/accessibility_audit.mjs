/**
 * generic_accessibility_audit — axe-core run against a product surface.
 *
 * Params arrive as GENERIC_ACCESSIBILITY_AUDIT_PLAN (dispatch already parsed and
 * refused malformed rows; the same parser runs again here). The page is loaded in
 * the same lifecycle generic_capture uses — patched Chromium on the
 * Stado-selected host, viewport and device scale factor applied through CDP —
 * then axe-core is injected from vendor/axe-core/axe.min.js in this repository.
 * Nothing is fetched from a CDN at run time: the audited page must not be able to
 * influence the auditor, and the axe build has to be the one the commit names.
 *
 * Two objects land under artifact_prefix:
 *   axe.json          the raw axe result, verbatim
 *   axe-summary.json  the attributed summary (renderer, weles + axe version,
 *                     violation/pass/incomplete counts, axe.json bytes + sha256)
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { parseAccessibilityAuditParams } from '../../../dist/worker/capture-params.js';
import {
  captureKeyPrefix, planFromEnv, startCaptureSession, uploadCaptureObject, welesVersion,
} from '../_shared/capture-runtime.mjs';

const label = 'generic_accessibility_audit';
const AXE_SOURCE_PATH = new URL('../../../vendor/axe-core/axe.min.js', import.meta.url).pathname;

const plan = planFromEnv('GENERIC_ACCESSIBILITY_AUDIT_PLAN', parseAccessibilityAuditParams);
const keyPrefix = captureKeyPrefix(plan.artifact_prefix);

let started = null;
try {
  console.log(`[a11y] ${plan.batch}/${plan.site_slug} url=${plan.source_url} viewport=${plan.viewport.width}x${plan.viewport.height}@${plan.viewport.device_scale_factor}x`);
  started = await startCaptureSession(label, plan);
  const { session, renderer } = started;
  const version = welesVersion();
  await session.goto(plan.source_url);
  await session.page.waitForLoadState('load').catch(() => {});

  const axeSource = readFileSync(AXE_SOURCE_PATH, 'utf8');
  await session.page.evaluate(axeSource);
  const axeVersion = await session.page.evaluate('window.axe && window.axe.version');
  if (typeof axeVersion !== 'string' || !axeVersion) {
    throw new Error('axe-core did not install itself in the page, so no audit was performed');
  }
  const capturedAt = new Date().toISOString();
  const axeResult = await session.page.evaluate('window.axe.run(document, { resultTypes: ["violations", "passes", "incomplete", "inapplicable"] })');
  if (!axeResult || !Array.isArray(axeResult.violations)) {
    throw new Error('axe-core returned no violations array, so the audit produced no measurable result');
  }

  const rawBody = JSON.stringify(axeResult);
  const rawPath = join(runRecordingsDir(label), 'axe.json');
  writeFileSync(rawPath, rawBody);
  const rawBytes = readFileSync(rawPath);
  const summary = {
    source_url: plan.source_url,
    viewport: plan.viewport,
    captured_at: capturedAt,
    renderer,
    weles_version: version,
    axe_version: axeVersion,
    violation_count: axeResult.violations.length,
    violations: axeResult.violations.map((violation) => ({
      id: String(violation.id ?? ''),
      impact: violation.impact === undefined || violation.impact === null ? null : String(violation.impact),
      help: String(violation.help ?? ''),
      node_count: Array.isArray(violation.nodes) ? violation.nodes.length : 0,
    })),
    passes_count: Array.isArray(axeResult.passes) ? axeResult.passes.length : 0,
    incomplete_count: Array.isArray(axeResult.incomplete) ? axeResult.incomplete.length : 0,
    bytes: rawBytes.byteLength,
    sha256: createHash('sha256').update(rawBytes).digest('hex'),
    capture_method: `Loaded ${plan.source_url} in ${renderer} on the Stado-selected Weles host at ${plan.viewport.width}x${plan.viewport.height} CSS px and device scale factor ${plan.viewport.device_scale_factor}, then ran the repository-vendored axe-core ${axeVersion} against the live document.`,
  };

  const rawUri = await uploadCaptureObject(keyPrefix, 'axe.json', rawBytes, 'application/json');
  const summaryUri = await uploadCaptureObject(keyPrefix, 'axe-summary.json', JSON.stringify(summary, null, 2), 'application/json');

  writeFileSync(join(runRecordingsDir(label), 'accessibility_audit_result.json'), JSON.stringify({
    ok: true,
    batch: plan.batch,
    site_slug: plan.site_slug,
    source_url: plan.source_url,
    artifact_prefix: plan.artifact_prefix,
    artifacts: [
      { key: `${keyPrefix}axe.json`, uri: rawUri, bytes: summary.bytes, sha256: summary.sha256 },
      { key: `${keyPrefix}axe-summary.json`, uri: summaryUri },
    ],
    axe_version: axeVersion,
    violation_count: summary.violation_count,
    passes_count: summary.passes_count,
    incomplete_count: summary.incomplete_count,
    renderer,
    weles_version: version,
    completed_at: new Date().toISOString(),
  }, null, 2));
  console.log(`PASS: ${label} violations=${summary.violation_count} ${rawUri} ${summaryUri}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  writeFileSync(join(runRecordingsDir(label), 'accessibility_audit_result.json'), JSON.stringify({
    ok: false,
    batch: plan.batch,
    site_slug: plan.site_slug,
    source_url: plan.source_url,
    artifact_prefix: plan.artifact_prefix,
    error: message,
    completed_at: new Date().toISOString(),
  }, null, 2));
  console.log('FAIL:', message.slice(Number('0'), Number('300')));
  process.exitCode = 1;
} finally {
  if (started) await started.session.close();
}

process.exit(process.exitCode ?? 0);
