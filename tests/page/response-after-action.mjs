// Run only on a Stado-selected dedicated Weles host, never on the operator's computer.
// node tests/page/response-after-action.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { responseAfterAction } from '../../src/trajectories/_shared/page/settled.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const runId = randomUUID();
const evidence = join(root, 'build', 'real-tests', 'response-after-action', runId);
await mkdir(evidence, { recursive: true });
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  source_sha256: createHash('sha256').update(await readFile(new URL('../../src/trajectories/_shared/page/settled.mjs', import.meta.url))).digest('hex'),
  command: [process.execPath, ...process.argv.slice(1)],
  host: hostname(),
  started_at: new Date().toISOString(),
  cases: [],
  status: 'running',
};
const describeError = (error) => ({
  name: error.name, message: error.message, code: error.code,
  requestMethod: error.requestMethod, requestUrl: error.requestUrl,
  pageUrl: error.pageUrl, errorText: error.errorText, stack: error.stack,
});
async function runCase(name, action) {
  try {
    report.cases.push({ name, status: 'passed', observed: await action() });
  } catch (error) {
    report.cases.push({ name, status: 'failed', error: describeError(error) });
  }
}
let session;
try {
  const { WSession } = await import('../../dist/index.js');
  session = await WSession.start({ label: `response_after_action_${runId}`, proxy: 'direct', browser: 'chromium' });
  report.capture_label = session.label;
  const page = session.page;
  await runCase('new_request_response', async () => {
    const earlier = `https://weles.wisent.com/docs?response_test=${runId}&phase=earlier`;
    const current = `https://weles.wisent.com/docs?response_test=${runId}&phase=current`;
    await page.goto(earlier, { waitUntil: 'domcontentloaded' }); // allow-raw-playwright: real read-only service navigation
    const response = await responseAfterAction(page,
      (request) => new URL(request.url()).pathname === '/docs',
      () => page.goto(current, { waitUntil: 'domcontentloaded' })); // allow-raw-playwright: real read-only service navigation
    assert.equal(response.status(), 200);
    assert.equal(response.url(), current);
    assert.equal(page.url(), current);
    return { response_url: response.url(), status: response.status(), final_url: page.url() };
  });
  await runCase('failed_request_after_dispatch', async () => {
    const target = `https://weles-response-${runId}.invalid/`;
    let navigation;
    let observed;
    await assert.rejects(responseAfterAction(page, (request) => request.url() === target, () => {
      // Retain the independent browser outcome without making it the action's
      // rejection: the observer must react to the actual requestfailed event.
      navigation = page.goto(target, { waitUntil: 'domcontentloaded' }).then(
        (response) => ({ response }), (error) => ({ error })); // allow-raw-playwright: real DNS failure on the reserved invalid domain
    }), (error) => {
      observed = error;
      assert.equal(error.code, 'REQUEST_FAILED');
      assert.equal(error.requestMethod, 'GET');
      assert.equal(error.requestUrl, target);
      return true;
    });
    const result = await navigation;
    assert.ok(result.error instanceof Error, 'the browser must have failed the navigation');
    return { observer: describeError(observed), navigation: describeError(result.error), final_url: page.url() };
  });
  await runCase('page_closed_before_request', async () => {
    await assert.rejects(responseAfterAction(page,
      (request) => new URL(request.url()).pathname === '/request-not-started',
      () => page.close()), { code: 'PAGE_CLOSED', requestUrl: null });
    assert.equal(page.isClosed(), true);
    await assert.rejects(responseAfterAction(page, () => true,
      () => page.goto('https://weles.wisent.com/docs')), { code: 'PAGE_CLOSED', requestUrl: null }); // allow-raw-playwright: a closed page must reject before navigation
    return { closed: page.isClosed() };
  });
} catch (error) {
  report.error = describeError(error);
} finally {
  if (session) {
    try { await session.close(); }
    catch (error) { report.cleanup_error = describeError(error); }
  }
  report.finished_at = new Date().toISOString();
  report.status = !report.error && !report.cleanup_error && report.cases.length === 3
    && report.cases.every((entry) => entry.status === 'passed') ? 'passed' : 'failed';
  process.exitCode = report.status === 'passed' ? 0 : 1;
  const reportPath = join(evidence, 'report.json');
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ report: reportPath, ...report }, null, 2));
}
