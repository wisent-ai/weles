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

test('explicit selectors refuse absent, ambiguous and invalid targets without clicking a substitute', async () => {
  const client = managedWeles('selector-click');
  const label = `selector-click-${randomUUID()}`;
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
      'Run these four click calls exactly once each and in order. This is a read-only browser regression. Do not log in, edit data, request permissions, open system dialogs or send notifications.',
      `First call click with target ${JSON.stringify(absent)}. The actual href attribute is relative, so this absolute selector must refuse with selector_target_absent. Confirm CURRENT URL remains ${measurementUrl}.`,
      `Then call click with target ${JSON.stringify(ambiguous)}. Several links are visible, so this must refuse with selector_target_ambiguous and leave CURRENT URL unchanged.`,
      `Then call click with target ${JSON.stringify(invalid)}. This malformed selector must refuse with selector_target_invalid and leave CURRENT URL unchanged.`,
      `Finally call click with target ${JSON.stringify(present)}. This exact relative selector must navigate to ${exportUrl}.`,
      'Do not replace any call with an observed description, another selector, navigate, js_click, focus or press_key. The first three refusals are expected, not a reason to repeat or improvise an action. If any outcome differs, call give_up with the actual result. Otherwise call done.',
    ].join('\n'),
  });
  const task = await client.captureBrowserRun(run, label);
  assert.equal(task.final_url, exportUrl);
  const clicks = task.history.filter(step => step.tool === 'click');
  assert.deepEqual(clicks.map(step => step.args.target), [absent, ambiguous, invalid, present]);
  assert.match(clicks[0].error, /\[selector_target_absent\]/);
  assert.match(clicks[1].error, /\[selector_target_ambiguous\]/);
  assert.match(clicks[2].error, /\[selector_target_invalid\]/);
  assert.equal(clicks[3].error, undefined, JSON.stringify(clicks[3]));
  assert.equal(task.history.some(step => !['click', 'done'].includes(step.tool)), false,
    'another action must not substitute for a refused selector');
  console.error(`real selector-click evidence: ${client.evidence}`);
});
