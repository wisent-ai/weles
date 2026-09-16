import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { managedWeles } from '../support/managed-weles.mjs';

const measurementUrl = 'https://www.wisent.com/docs/components/figma-measurement';
const exportUrl = 'https://www.wisent.com/docs/components/figma-export';

test('an indexed observed link navigates and its obsolete description is refused', () => runObservedClick(true));
test('an unindexed observed link navigates and its obsolete description is refused', () => runObservedClick(false));

test('a scoped sign-in credential stays unchanged when literal input is refused', {
  skip: !process.env.WELES_REAL_LOGIN_ITEM && 'requires an authorized real login item',
}, async () => {
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
    objective: [
      'Verify the protected, already-prefilled Email or phone field without submitting it.',
      'Exercise these three literal-input requests, in order, and record their actual outcomes:',
      'type_text with {"value":"unexpected-entry"};',
      'fill with {"target":"input[id=\\"identifierId\\"]","value":"unexpected-entry"};',
      'set_control with {"selector":"#identifierId","value":"unexpected-entry"}.',
      'Each should refuse because a credential field requires fill_credential. A deliberate refusal is an expected test outcome; do not retry, fix it or use another action.',
      'Then use read to inspect the rendered account address and call done with a brief summary. Report the actual value, even if an input changed it.',
      'Do not click, focus, press keys, navigate, register, submit the form, request approval, open system dialogs or send notifications. Do not invent an account.',
    ].join('\n'),
  });
  const task = await client.captureBrowserRun(run, label);
  const accountObservation = task.history.find(step => step.tool === 'read');
  assert.match(accountObservation?.result ?? '', /@[a-z0-9.-]+\.[a-z]{2,}/i,
    'the scoped prefill must leave an observed account address, not an empty field');
  assert.equal(new URL(task.final_url).origin, 'https://accounts.google.com');
  for (const tool of ['type_text', 'fill', 'set_control']) {
    const attempts = task.history.filter(step => step.tool === tool);
    assert.ok(attempts[0], `the real browser did not exercise ${tool}`);
    for (const attempt of attempts) {
      assert.match(attempt.error, /credential fields require fill_credential/,
        `${tool} must refuse before changing the protected field`);
    }
  }
  const inventory = JSON.parse(readFileSync(`${client.evidence}/artifact-inventory.json`, 'utf8')).body.files;
  const refusedFrames = inventory.filter(file => file.path.startsWith(`${label}/error_`) && file.path.endsWith('.png'));
  assert.equal(refusedFrames.length, 3, 'all three refusals must retain their actual rendered state');
  for (const frame of refusedFrames) {
    const step = /\/error_(\d+)_/.exec(frame.path)[1];
    const before = inventory.find(file => file.path.startsWith(`${label}/before_${step}_`) && file.path.endsWith('.png'));
    assert.ok(before, `missing the rendered page before refused step ${step}`);
    const beforeName = `guard-${step}-before.png`;
    const afterName = `guard-${step}-after.png`;
    await client.download(beforeName, before.download_url);
    await client.download(afterName, frame.download_url);
    assert.ok(readFileSync(`${client.evidence}/${beforeName}`).equals(readFileSync(`${client.evidence}/${afterName}`)),
      `refused step ${step} changed the actual rendered page`);
  }
  assert.ok(task.history.every(step => ['type_text', 'fill', 'set_control', 'read', 'wait', 'done'].includes(step.tool)),
    'the credential regression must not submit or navigate the login form');
  console.error(`real credential-prefill evidence: ${client.evidence}`);
});

test('prefilled sign-in continues without reopening or refilling the account', {
  skip: !process.env.WELES_REAL_LOGIN_ITEM && 'requires an authorized real login item',
}, async () => {
  const client = managedWeles('prefill-continuation');
  const label = `prefill-continuation-${randomUUID()}`;
  client.retain('test-command.json', {
    argv: process.argv, execArgv: process.execArgv,
    test_sha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
  });
  process.once('exit', code => client.retain('exit.json', { exit_code: code }));
  const run = client.runBrowserPlan('browser-run', {
    schema: 'wisent.weles-browser-task-plan.v1',
    action: 'generic_browser_task',
    url: 'https://myaccount.google.com/apppasswords',
    session_label: label,
    flow_name: label,
    fresh_profile: true,
    allow_login: true,
    sign_in_origin: 'https://accounts.google.com',
    sign_in_item: process.env.WELES_REAL_LOGIN_ITEM,
    objective: [
      'Continue from the current Google sign-in page and its already-prefilled account address.',
      'Use the Next button once to submit only that existing identifier, then read the resulting page and report its visible authentication methods.',
      'Stop after observing that next page. Do not fill or submit a password, start a passkey, request approval or send a notification.',
      'Do not navigate, refill any field, change the selected account, register, recover the account, alter security settings or create an app password.',
      'If the identifier is empty, stop and report the actual state rather than substituting an account or retrying a consumed credential.',
      'A form submission for the account identifier is the only permitted change. No system dialogs, SMS, email or trusted-device prompts.',
    ].join('\n'),
  });
  const task = await client.captureBrowserRun(run, label);
  const finalUrl = new URL(task.final_url);
  assert.equal(finalUrl.origin, 'https://accounts.google.com');
  assert.match(finalUrl.pathname, /\/challenge\//,
    'the real provider must advance beyond the identifier page');
  const clicks = task.history.filter(step => step.tool === 'click' && !step.error);
  assert.equal(clicks.length, 1, 'only the account identifier may be submitted');
  assert.match(String(clicks[0].args.target), /\bNext\b/i,
    'the only successful click must be the identifier Next control');
  const observation = task.history.findLast(step => step.tool === 'read');
  assert.match(observation?.result ?? '', /password|passkey|verification|verify|security key|authenticator/i,
    'the resulting authentication page must actually be observed');
  assert.ok(task.history.every(step => ['click', 'read', 'wait', 'done'].includes(step.tool)),
    'continuation must not repeat initialization or supply another credential');
  console.error(`real prefill-continuation evidence: ${client.evidence}`);
});

test('ordinary search fields accept literal keyboard, fill and control edits', async () => {
  const client = managedWeles('literal-input');
  const label = `literal-input-${randomUUID()}`;
  client.retain('test-command.json', {
    argv: process.argv, execArgv: process.execArgv,
    test_sha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
  });
  process.once('exit', code => client.retain('exit.json', { exit_code: code }));
  const run = client.runBrowserPlan('browser-run', {
    schema: 'wisent.weles-browser-task-plan.v1',
    action: 'generic_keeper_task',
    url: 'https://skarbiec.wisent.com/docs',
    session_label: label,
    flow_name: label,
    fresh_profile: true,
    allow_login: false,
    objective: [
      'Exercise the public documentation search input without submitting a form or opening a search result.',
      'Call fill with {"target":"input[type=\\"search\\"]","value":"weles"}, then read the actual displayed search text.',
      'Call type_text with {"value":" docs"}, then read the actual displayed search text.',
      'Call set_control with {"selector":"input[type=\\"search\\"]","value":"weles search"}, then read the actual displayed search text.',
      'All three read calls are required, including after set_control. Ask only what text is displayed in the search field; never supply an expected answer.',
      'After those observed outcomes, call done with a brief summary. A successful tool return is not a substitute for reading the resulting field.',
      'Do not click, navigate, press keys, log in, submit a form, open system dialogs, request permissions or send notifications.',
    ].join('\n'),
  });
  const task = await client.captureBrowserRun(run, label);
  assert.equal(task.final_url, 'https://skarbiec.wisent.com/docs');
  for (const [tool, expected] of [['fill', 'weles'], ['type_text', 'weles docs'], ['set_control', 'weles search']]) {
    const index = task.history.findIndex(step => step.tool === tool);
    assert.ok(index >= 0, `the real search did not exercise ${tool}`);
    assert.equal(task.history[index].error, undefined, JSON.stringify(task.history[index]));
    const observation = task.history.slice(index + 1).find(step => step.tool !== 'wait');
    assert.equal(observation?.tool, 'read', `the result of ${tool} must be read before another action`);
    assert.match(observation.result, new RegExp(`\\b${expected}\\b`),
      `the real page must show the result of ${tool}`);
  }
  assert.ok(task.history.filter(step => step.tool === 'read').length >= 3,
    'each input outcome must be observed on the real page');
  assert.ok(task.history.every(step => ['fill', 'type_text', 'set_control', 'read', 'wait', 'done'].includes(step.tool)),
    'the search regression must not submit or leave the public page');
  console.error(`real literal-input evidence: ${client.evidence}`);
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
