import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { managedWeles } from '../support/managed-weles.mjs';

const measurementUrl = 'https://www.wisent.com/docs/components/figma-measurement';
const exportUrl = 'https://www.wisent.com/docs/components/figma-export';

test('an indexed observed link navigates and its obsolete description is refused', () => runObservedClick(true));
test('an unindexed observed link navigates and its obsolete description is refused', () => runObservedClick(false));

test('a scoped sign-in credential fills the existing account without registration', {
  skip: !process.env.WELES_REAL_LOGIN_ITEM && 'requires an authorized real login item and expected account',
}, async () => {
  assert.ok(process.env.WELES_REAL_LOGIN_EMAIL, 'WELES_REAL_LOGIN_EMAIL is required');
  const client = managedWeles('credential-prefill');
  const label = `credential-prefill-${randomUUID()}`;
  client.retain('test-command.json', {
    argv: process.argv, execArgv: process.execArgv,
    test_sha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
  });
  process.once('exit', code => client.retain('exit.json', { exit_code: code }));
  const run = client.runBrowserPlan('browser-run', {
    schema: 'wisent.weles-browser-task-plan.v1',
    action: 'generic_browser_task',
    url: 'https://accounts.google.com/',
    session_label: label,
    flow_name: label,
    fresh_profile: true,
    allow_login: true,
    sign_in_origin: 'https://accounts.google.com',
    sign_in_item: process.env.WELES_REAL_LOGIN_ITEM,
    objective: 'Read the exact account address already present in the Email or phone field. Use read to inspect the rendered field, then call done with {"account": "<observed field value>"}. Do not type, fill, click, press keys, navigate, register, submit the form, or request approval, system permissions or notifications. Do not invent an account. If the field is empty or unreadable, report that failure instead.',
  });
  const task = await client.captureBrowserRun(run, label);
  assert.equal(task.value?.account, process.env.WELES_REAL_LOGIN_EMAIL);
  assert.equal(new URL(task.final_url).origin, 'https://accounts.google.com');
  assert.ok(task.history.every(step => ['read', 'wait', 'done'].includes(step.tool)),
    'observation after protected prefill must not mutate or submit the login form');
  console.error(`real credential-prefill evidence: ${client.evidence}`);
});

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
      ...(indexed ? [
        'First, deliberately call click with target set to the empty string exactly once. This must refuse before any input. Confirm CURRENT URL remains the measurement URL.',
        'After that expected empty-target refusal, continue with the actual observed link below; do not repeat the empty click.',
      ] : []),
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
  const task = await client.captureBrowserRun(run, label);
  assert.equal(task.final_url, exportUrl);
  const clicks = task.history.filter(step => step.tool === 'click');
  if (indexed) {
    const empty = clicks.shift();
    assert.equal(empty?.args.target, '');
    assert.match(empty?.error ?? '', /\[target_empty\]/);
  }
  assert.ok(clicks.length >= 2, 'the browser must exercise both the live target and its obsolete description');
  assert.match(clicks[0].args.target, indexed ? /^\[\d+\]\s*a\s/ : /^a\s/);
  assert.ok(clicks[0].args.target.endsWith(`href=${exportUrl}`));
  assert.equal(clicks[0].error, undefined, JSON.stringify(clicks[0]));
  for (const refused of clicks.slice(1)) {
    assert.equal(refused.args.target, clicks[0].args.target);
    assert.match(refused.error, /\[observed_target_stale\]/);
  }
  assert.equal(task.history.some(step => ['navigate', 'js_click'].includes(step.tool)), false,
    'direct navigation must not substitute for the observed link click');
  console.error(`real observed-click evidence: ${client.evidence}`);
}
