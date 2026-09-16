import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { managedWeles } from '../support/managed-weles.mjs';

const measurementUrl = 'https://www.wisent.com/docs/components/figma-measurement';
const exportUrl = 'https://www.wisent.com/docs/components/figma-export';
const absent = `a[href='${exportUrl}']`;
const ambiguous = 'a';
const invalid = 'a[broken-selector';
const present = "a[href='/docs/components/figma-export']";

for (const scenario of [
  { name: 'absent literal selector', target: absent, error: 'selector_target_absent' },
  { name: 'ambiguous literal selector', target: ambiguous, error: 'selector_target_ambiguous' },
  { name: 'invalid literal selector', target: invalid, error: 'selector_target_invalid' },
  { name: 'unique literal selector', target: present },
]) {
  test(`${scenario.name} preserves its requested target and observed outcome`, async () => {
    const client = managedWeles('selector-click');
    const label = `selector-click-${randomUUID()}`;
    client.retain('test-command.json', {
      argv: process.argv, execArgv: process.execArgv, scenario,
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
        'Perform exactly one click call for this read-only browser regression, then call done.',
        `The complete click arguments are this JSON object: ${JSON.stringify({ target: scenario.target })}`,
        'Copy that target exactly, including every quote and bracket. Do not repair or replace it.',
        scenario.error
          ? `The expected result is ${scenario.error}; CURRENT URL must remain ${measurementUrl}. This deliberate refusal is a successful test operation, not a reason to retry.`
          : `The expected result is navigation to ${exportUrl}.`,
        'After the one click, call done with its actual outcome even if it differs from the expectation. Do not repeat the click or invent a result.',
        'Do not navigate, use js_click, focus, press keys, log in, edit data, request permissions, open system dialogs or send notifications.',
      ].join('\n'),
    });
    const task = await client.captureBrowserRun(run, label);
    assert.equal(task.final_url, scenario.error ? measurementUrl : exportUrl);
    const clicks = task.history.filter(step => step.tool === 'click');
    assert.deepEqual(clicks.map(step => step.args.target), [scenario.target]);
    if (scenario.error) assert.match(clicks[0].error, new RegExp(`\\[${scenario.error}\\]`));
    else assert.equal(clicks[0].error, undefined, JSON.stringify(clicks[0]));
    assert.equal(task.history.some(step => !['click', 'done'].includes(step.tool)), false,
      'another action must not substitute for the requested selector');
    console.error(`real selector-click evidence: ${client.evidence}`);
  });
}
