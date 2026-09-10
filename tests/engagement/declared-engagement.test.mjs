// Real Weles engagement, with a test-owned repository and external read-back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { managedWeles } from '../support/managed-weles.mjs';

function github(client, step, method, path, body) {
  const args = ['api', '--method', method, path];
  const options = { encoding: 'utf8' };
  if (body !== undefined) {
    args.push('--input', '-');
    options.input = JSON.stringify(body);
  }
  const output = spawnSync('gh', args, options);
  client.retain(`${step}.json`, { command: ['gh', ...args], exit_code: output.status, stdout: output.stdout, stderr: output.stderr });
  return output;
}

test('declared engagement changes the real repository and refuses its removed action', async (t) => {
  const client = managedWeles('engagement');
  const identity = await client.request('worker-version', '/worker/version');
  assert.equal(identity.status, 200, JSON.stringify(identity.body));
  const ownerRead = github(client, 'github-owner', 'GET', '/user');
  assert.equal(ownerRead.status, 0, ownerRead.stderr);
  const owner = JSON.parse(ownerRead.stdout).login;
  const name = `weles-engagement-test-${randomUUID()}`;
  const repository = `${owner}/${name}`;
  const created = github(client, 'create-repository', 'POST', '/user/repos', { name, private: false, auto_init: true, description: 'Disposable repository owned by the Weles engagement regression; removed at the end of the run.' });
  assert.equal(created.status, 0, created.stderr);
  t.after(() => {
    const removed = github(client, 'remove-repository', 'DELETE', `/repos/${repository}`);
    assert.equal(removed.status, 0, removed.stderr);
    const absent = github(client, 'repository-absence', 'GET', `/repos/${repository}`);
    assert.notEqual(absent.status, 0);
    assert.match(absent.stderr, /404/);
  });
  const before = github(client, 'stars-before', 'GET', `/repos/${repository}/stargazers`);
  assert.equal(before.status, 0, before.stderr);
  assert.deepEqual(JSON.parse(before.stdout), []);
  const run = await client.request('engagement', '/run', {
    action: 'generic_saved_task', params: { engagement: 'github.star', target_url: `https://github.com/${repository}` }, creds: 'redact',
  });
  if (run.body.run_id) await client.request('diagnostics', `/diagnostics/${encodeURIComponent(run.body.run_id)}`);
  assert.equal(run.status, 200, JSON.stringify(run.body));
  assert.equal(run.body.ok, true, JSON.stringify(run.body));
  const manifest = await client.request('completed-diagnostics', `/diagnostics/${encodeURIComponent(run.body.run_id)}`);
  assert.equal(manifest.status, 200);
  const artifact = manifest.body.files.find((file) => file.path.endsWith('/ban_signal.json'));
  assert.ok(artifact, 'the engagement left no persisted browser result');
  const signal = await client.request('engagement-state', artifact.download_url);
  assert.equal(signal.status, 200);
  assert.equal(signal.body.repo_url, `https://github.com/${repository}`);
  const after = github(client, 'stars-after', 'GET', `/repos/${repository}/stargazers`);
  assert.equal(after.status, 0, after.stderr);
  assert.ok(JSON.parse(after.stdout).some((account) => account.login === signal.body.username), 'GitHub did not record the star for the account Weles used');
  const refused = await client.request('removed-action', '/run', { action: 'github_star', params: { target_url: `https://github.com/${repository}` } });
  assert.notEqual(refused.body.ok, true, JSON.stringify(refused.body));
  const unchanged = github(client, 'stars-after-refusal', 'GET', `/repos/${repository}/stargazers`);
  assert.equal(unchanged.status, 0, unchanged.stderr);
  assert.deepEqual(JSON.parse(unchanged.stdout), JSON.parse(after.stdout));
  console.error(`real engagement evidence: ${client.evidence}`);
});
