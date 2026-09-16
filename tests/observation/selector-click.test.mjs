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
        'Exercise this literal selector through click for a read-only browser regression.',
        `The complete click arguments are this JSON object: ${JSON.stringify({ target: scenario.target })}`,
        'Copy that target exactly, including every quote and bracket. Do not repair or replace it.',
        scenario.error
          ? `The expected result is ${scenario.error}; CURRENT URL must remain ${measurementUrl}. This deliberate refusal is a successful test operation, not a reason to retry.`
          : `The expected result is navigation to ${exportUrl}.`,
        'After the click, call done with its actual outcome. Reading the page to verify its state is allowed; do not invent a result.',
        'Do not navigate, use js_click, focus, press keys, log in, edit data, request permissions, open system dialogs or send notifications.',
      ].join('\n'),
    });
    const task = await client.captureBrowserRun(run, label);
    assert.equal(task.final_url, scenario.error ? measurementUrl : exportUrl);
    const clicks = task.history.filter(step => step.tool === 'click');
    const requested = clicks.filter(click => click.args.target === scenario.target);
    assert.ok(requested[0], 'the browser must exercise the requested selector');
    for (const click of clicks.filter(click => click.args.target !== scenario.target)) {
      assert.match(click.error, /\[selector_target_invalid\]/,
        'a malformed model argument must refuse, never click another target');
    }
    for (const [index, click] of requested.entries()) {
      if (scenario.error) assert.match(click.error, new RegExp(`\\[${scenario.error}\\]`));
      else if (index === 0) assert.equal(click.error, undefined, JSON.stringify(click));
      else assert.match(click.error, /\[selector_target_absent\]/,
        'the old link must refuse if retried on the destination');
    }
    assert.equal(task.history.some(step => !['click', 'read', 'wait', 'done'].includes(step.tool)), false,
      'another action must not substitute for the requested selector');
    console.error(`real selector-click evidence: ${client.evidence}`);
  });
}
