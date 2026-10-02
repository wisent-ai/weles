import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceFor } from '../security/evidence.mjs';

// These are real CLI refusals, not a payment-provider qualification. Every
// child lacks payment consent, card data and a usable scoped account identity.
const root = fileURLToPath(new URL('../../', import.meta.url));
const evidence = await evidenceFor('topup-authorization');
evidence.report.scope = 'preflight_refusals_only';
evidence.report.provider_flow = 'not_run';
evidence.report.node_version = process.version;
const cases = [
  { name: 'missing_payment_consent', usd: '10', exit: 2, setting: 'TOPUP_CONFIRM=1' },
  { name: 'invalid_amount_before_missing_consent', usd: '0', exit: 1, setting: 'TOPUP_USD=0' },
];
const failures = [];
try {
  for (const provider of ['fivesim', 'juicysms']) {
    for (const scenario of cases) {
      const home = await mkdtemp(join(root, 'build/real-tests/topup-authorization/home-'));
      const entry = join(root, 'src/trajectories', provider, 'topup.mjs');
      const overrides = {
        HOME: home, WELES_RUN_OUTPUT_DIR: join(home, 'runs'),
        WELES_CREDENTIALS_FILE: '', SKARBIEC_WORKLOAD_ID: '', SKARBIEC_WORKLOAD_SIGNING_KEY_FILE: '',
        TOPUP_CARD_NUMBER: '', TOPUP_CARD_EXP: '', TOPUP_CARD_CVC: '',
        TOPUP_CARD_ZIP: '', TOPUP_CARD_NAME: '', TOPUP_CARD_JSON: '',
        TOPUP_CONFIRM: '0', TOPUP_USD: scenario.usd,
      };
      const operation = { provider, scenario: scenario.name, command: [process.execPath, entry], cwd: home, environment_overrides: overrides };
      evidence.report.operations.push(operation);
      try {
        const result = spawnSync(process.execPath, [entry], {
          cwd: home, env: { ...process.env, ...overrides }, encoding: 'utf8',
        });
        Object.assign(operation, {
          exit_status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr,
          error: result.error?.message ?? null, home_entries_after: await readdir(home, { recursive: true }),
        });
        assert.equal(result.error, undefined, result.error?.message);
        assert.equal(result.signal, null, `${provider}/${scenario.name} terminated by a signal`);
        assert.equal(result.status, scenario.exit, `${provider}/${scenario.name}: ${result.stderr || result.stdout}`);
        // Check the refused setting and value, not the surrounding prose.
        assert.ok(`${result.stdout}\n${result.stderr}`.includes(scenario.setting), `${provider}/${scenario.name} did not identify ${scenario.setting}`);
        assert.equal(operation.home_entries_after.some(path => path.endsWith('checkout_attempt.json') || path.endsWith('payment_receipt.json')), false,
          'an authorization refusal must not produce a checkout or payment receipt');
        operation.status = 'passed';
      } catch (error) {
        operation.status = 'failed';
        operation.failure = error.message;
        failures.push(`${provider}/${scenario.name}: ${error.message}`);
      } finally {
        await rm(home, { recursive: true });
      }
    }
  }
  evidence.report.status = failures.length ? 'failed' : 'passed';
  evidence.report.failures = failures;
  if (failures.length) process.exitCode = 1;
} catch (error) {
  evidence.report.status = 'failed';
  evidence.report.failure = error.message;
  process.exitCode = 1;
} finally {
  await evidence.finish();
}
