// Real declared observation, never a generated replacement trajectory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { managedWeles } from '../support/managed-weles.mjs';

const observation = 'github.profile_view';
const handle = 'wisent-ai';

test('declared observation reads the real page and leaves its own persisted evidence', async () => {
  const client = managedWeles('observation');
  const identity = await client.request('worker-version', '/worker/version');
  assert.equal(identity.status, 200, JSON.stringify(identity.body));
  const run = await client.request('observation', '/run', {
    action: 'generic_keeper_task', params: { observation, handle }, creds: 'redact',
  });
  if (run.body.run_id) {
    await client.request('diagnostics', `/diagnostics/${encodeURIComponent(run.body.run_id)}`);
  }
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.ok, true, JSON.stringify(run.body));
  const runId = run.body.run_id;
  assert.equal(typeof runId, 'string');
  const manifest = await client.request('completed-diagnostics', `/diagnostics/${encodeURIComponent(runId)}`);
  assert.equal(manifest.status, 200, JSON.stringify(manifest.body));
  const signalFile = manifest.body.files.find((file) => file.path.endsWith('/ban_signal.json'));
  assert.ok(signalFile, 'the real browser trajectory did not persist an observation');
  const signal = await client.request('observed-state', signalFile.download_url);
  assert.equal(signal.status, 200);
  assert.equal(signal.body.observation, observation);
  assert.equal(signal.body.origin, `https://github.com/${handle}`);
  assert.equal(signal.body.reads, 'profile');
  assert.equal(signal.body.healthy, true, JSON.stringify(signal.body));

  const refused = await client.request('undeclared-observation', '/run', {
    action: 'generic_keeper_task', params: { observation: 'github.not-declared' }, creds: 'redact',
  });
  assert.notEqual(refused.body.ok, true, JSON.stringify(refused.body));
  assert.match(JSON.stringify(refused.body), /observation github\.not-declared is not declared/);
  const unchanged = await client.request('successful-state-after-refusal', signalFile.download_url);
  assert.deepEqual(unchanged.body, signal.body, 'a refused run changed the successful observation');
  console.error(`real observation evidence: ${client.evidence}`);
});
