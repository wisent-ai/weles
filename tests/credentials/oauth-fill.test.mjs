import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { managedWeles } from '../support/managed-weles.mjs';

for (const repeat of [false, true]) {
  test(repeat ? 'a consumed credential stops the real browser run' : 'OAuth input retains the scoped credential in its bound field', async () => {
    const client = managedWeles('oauth-fill');
    const label = `oauth-fill-${randomUUID()}`;
    client.retain('test-command.json', {
      argv: process.argv, execArgv: process.execArgv, repeat,
      test_sha256: createHash('sha256').update(readFileSync(import.meta.filename)).digest('hex'),
    });
    process.once('exit', code => client.retain('exit.json', { exit_code: code }));
    const run = client.runBrowserPlan('browser-run', {
      schema: 'wisent.weles-browser-task-plan.v1',
      action: 'generic_keeper_task',
      url: 'https://www.figma.com/login',
      session_label: label,
      flow_name: label,
      fresh_profile: true,
      allow_login: true,
      sign_in_origin: 'https://accounts.google.com',
      sign_in_item: 'weles-google-sso-login',
      defer_fills: true,
      windowed: false,
      objective: [
        'This is a protected-input regression, not a completed sign-in or a Figma edit.',
        'On the normal Figma login page, click the observed control with target="button type=button label=Continue with Google" once, then wait for its Google identifier field. Never pass a bare control index such as "0"; a current complete control description is required. Do not ask the screenshot reader for a URL or DOM attributes; use CURRENT URL and CONTROLS.',
        'Use fill_credential with field_class=email and the supplied accounts.google.com/email capability.',
        repeat
          ? 'For target, copy the entire current CONTROLS entry for the Email or phone input, including its index and every field. Never change the capability.'
          : 'Once CURRENT URL is on accounts.google.com and Email or phone is visible, use the plain field description target=\"email\". Never use the Figma login field or change the capability.',
        'After filling, use read to inspect whether the visible Email or phone field contains a value. Report only that boolean, never the account value.',
        repeat
          ? 'After the first verified fill, deliberately call fill_credential once more with target="email", field_class="email", and the SAME email capability. The plain visible field description avoids replaying a DOM description that changed when the field gained a value. This must terminate with CAPABILITY_DENIED. Do not substitute another capability, use the old indexed description, call done, or treat observed_target_stale as a broker denial.'
          : 'After that visual check, call done with value {\"field_populated\": true or false}, using the observed boolean even if the field is empty. Do not submit the identifier form.',
        'Never click Next, submit a form, use the password capability, register, request approval, open system dialogs, send notifications or edit Figma data.',
        'Do not clear the field or use fill, type_text, set_control or js_click.',
      ].join('\n'),
    });
    const task = await client.captureBrowserRun(run, label, { success: !repeat });
    assert.equal(new URL(task.final_url).origin, 'https://accounts.google.com');
    const fills = task.history.filter(step => step.tool === 'fill_credential');
    const successful = fills.filter(step => !step.error && step.result?.startsWith('credential filled'));
    assert.equal(successful.length, 1, 'one scoped fill must complete on the Google field');
    const denied = fills.filter(step => step.error?.includes('CAPABILITY_DENIED'));
    for (const refused of fills.filter(step => step.error && !denied.includes(step))) {
      assert.match(refused.error, /capability operation mismatch|\[credential_target_description_mismatch\]|\[observed_target_stale\]/,
        'only a pre-redemption target refusal can be corrected');
    }
    if (repeat) {
      assert.equal(denied.length, 1, 'redemption stops on its first denial');
      assert.equal(denied[0].args.capability.capability_id, successful[0].args.capability.capability_id);
      assert.equal(task.history.at(-1), denied[0]);
      assert.equal(task.history.some(step => step.tool === 'done'), false);
    } else {
      assert.equal(denied.length, 0);
      assert.equal(task.history.at(-1).tool, 'done');
      assert.equal(task.value?.field_populated, true, 'the final rendered identifier field must retain its input');
      const cache = join(client.evidence, 'cache');
      const previousCache = process.env.WELES_CACHE_DIR;
      process.env.WELES_CACHE_DIR = cache;
      try {
        const { saveFlow, loadFlow } = createRequire(import.meta.url)('../../dist/session/flows.js');
        assert.equal(saveFlow(label, task.history), false);
        assert.equal(loadFlow(label), null, 'a consumed capability is not a reusable flow');
        assert.equal(existsSync(join(cache, 'flows', `${label}.json`)), false);
      } finally {
        if (previousCache === undefined) delete process.env.WELES_CACHE_DIR;
        else process.env.WELES_CACHE_DIR = previousCache;
        rmSync(cache, { recursive: true, force: true });
      }
    }
    assert.equal(task.history.some(step => !['click', 'fill_credential', 'read', 'wait', 'done'].includes(step.tool)), false);
    console.error(`real OAuth fill evidence: ${client.evidence}`);
  });
}
