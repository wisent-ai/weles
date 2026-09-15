import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { managedWeles } from '../support/managed-weles.mjs';

const measurementUrl = 'https://www.wisent.com/docs/components/figma-measurement';
const exportUrl = 'https://www.wisent.com/docs/components/figma-export';

test('an indexed observed link navigates and its obsolete description is refused', () => runObservedClick(true));
test('an unindexed observed link navigates and its obsolete description is refused', () => runObservedClick(false));

async function runObservedClick(indexed) {
  const client = managedWeles('observed-click');
  const label = `observed-click-${randomUUID()}`;
  client.retain('test-command.json', {
    argv: process.argv, execArgv: process.execArgv,
    test_sha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
  });
  process.once('exit', code => client.retain('exit.json', { exit_code: code }));
  const run = client.runBrowserPlan('browser-run', {
    schema: 'wisent.weles-browser-task-plan.v1',
    action: 'generic_keeper_task',
    url: measurementUrl,
    session_label: label,
    flow_name: label,
    fresh_profile: true,
    allow_login: false,
    objective: [
      'Run this read-only browser regression in order. Do not log in, edit data, request permissions, open system dialogs or send notifications.',
      `On ${measurementUrl}, find the version-pinned export workflow link in the current CONTROLS observation.`,
      'Keep the complete observed tag, label, href and any other reported fields. Do not invent or shorten any field.',
      indexed
        ? 'Include the leading [index] exactly as the current observation reports it.'
        : 'Omit only the leading [index]; pass the complete remaining description beginning with the tag.',
      'Call click(target) with exactly that complete description. Do not replace this click with navigate, js_click, a CSS selector or a plain label.',
      `Wait until CURRENT URL is ${exportUrl}.`,
      'Now call click(target) once with exactly the old complete description from the measurement page. It is obsolete on this new page and must be refused.',
      'After this expected refusal, do not retry it, navigate elsewhere, or click a replacement. Call done with the observed result. This deliberate refusal is the final test step, not a reason to improvise another action.',
    ].join('\n'),
  });
  assert.equal(typeof run.body.run_id, 'string', JSON.stringify(run.body));
  const manifest = await client.request('artifact-inventory', `/diagnostics/${encodeURIComponent(run.body.run_id)}`);
  assert.equal(manifest.status, 200, JSON.stringify(manifest.body));
  const files = manifest.body.files;
  const taskFile = files.find(file => file.path.endsWith('/generic_task_result.json'));
  const runtimeFile = files.find(file => file.path === 'run-result.json');
  assert.ok(taskFile, 'the browser did not retain its final state');
  assert.ok(runtimeFile, 'the worker did not retain its exact runtime revision');
  const task = await client.request('browser-state', taskFile.download_url);
  const runtime = await client.request('runtime-source', runtimeFile.download_url);
  const recording = files.find(file => file.path.startsWith(`${label}/`) && file.path.endsWith('.webm'));
  const screenshot = files.filter(file => file.path.startsWith(`${label}/`) && file.path.endsWith('.png'))
    .sort((left, right) => left.modified_at.localeCompare(right.modified_at)).at(-1);
  assert.ok(recording, 'the real browser recording is missing');
  assert.ok(screenshot, 'the final rendered browser state is missing');
  await client.download('journey.webm', recording.download_url);
  await client.download('final-page.png', screenshot.download_url);
  assert.equal(task.status, 200);
  assert.equal(runtime.status, 200);
  if (process.env.WELES_REAL_EXPECTED_REVISION) {
    assert.equal(runtime.body.source_revision, process.env.WELES_REAL_EXPECTED_REVISION);
  }
  assert.equal(run.body.ok, true, JSON.stringify(run.body));
  assert.equal(run.exit_code, 0);
  assert.equal(task.body.ok, true, JSON.stringify(task.body));
  assert.equal(task.body.final_url, exportUrl);
  const clicks = task.body.history.filter(step => step.tool === 'click');
  assert.equal(clicks.length, 2, 'both the live target and obsolete target must actually be attempted');
  assert.match(clicks[0].args.target, indexed ? /^\[\d+\]\s*a\s/ : /^a\s/);
  assert.ok(clicks[0].args.target.endsWith(`href=${exportUrl}`));
  assert.equal(clicks[0].error, undefined, JSON.stringify(clicks[0]));
  assert.equal(clicks[1].args.target, clicks[0].args.target);
  assert.match(clicks[1].error, /\[observed_target_stale\]/);
  assert.equal(task.body.history.some(step => ['navigate', 'js_click'].includes(step.tool)), false,
    'direct navigation must not substitute for the observed link click');
  console.error(`real observed-click evidence: ${client.evidence}`);
}
