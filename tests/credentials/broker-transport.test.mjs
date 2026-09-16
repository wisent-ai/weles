import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '../..');
const root = join(repo, '.wisent-output/cap');
mkdirSync(root, { recursive: true });
const evidence = mkdtempSync(join(root, 'run-'));
const scratch = join(evidence, 'scratch');
mkdirSync(scratch);
const socketPath = join(evidence, 'stale');
assert.ok(Buffer.byteLength(socketPath) < 104, 'the real Unix socket path must fit the macOS limit');
const keyPath = join(scratch, 'signing-key.pem');
const { privateKey } = generateKeyPairSync('ed25519');
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const changes = {
  SKARBIEC_CAP_SOCKET: socketPath,
  SKARBIEC_WORKLOAD_ID: 'weles-broker-transport-test',
  SKARBIEC_WORKLOAD_SIGNING_KEY_FILE: keyPath,
  WELES_CACHE_DIR: join(scratch, 'cache'),
};
const previous = Object.fromEntries(Object.keys(changes).map(key => [key, process.env[key]]));
Object.assign(process.env, changes);
const require = createRequire(import.meta.url);
const { redeemCapability } = require(join(repo, 'dist/utils/capability.js'));
const { saveFlow, loadFlow, replayFlow } = require(join(repo, 'dist/session/flows.js'));
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  command: [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
  compiled_sha256: Object.fromEntries(['utils/capability/broker', 'session/flows'].map(name => [
    name, createHash('sha256').update(readFileSync(join(repo, `dist/${name}.js`))).digest('hex'),
  ])),
  socket: socketPath,
};
writeFileSync(join(evidence, 'source.patch'), execFileSync('git', ['diff', 'HEAD', '--', 'src/utils/capability/broker.ts', 'src/agent/loop.ts'], { cwd: repo }));
after(() => {
  rmSync(socketPath, { force: true });
  rmSync(scratch, { recursive: true, force: true });
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.error(`real broker transport evidence: ${evidence}`);
});
process.once('exit', code => writeFileSync(join(evidence, 'exit.json'), JSON.stringify({ exit_code: code }) + '\n'));

test('a stale kernel socket preserves the redemption failure instead of reaching a cached success', async () => {
  // Produce an actual stale Unix socket, not a responding credential provider.
  // No request is sent while the listener exists, and no response is fabricated.
  const originalPath = join(evidence, 'live');
  const listener = createServer();
  try {
    await new Promise((resolve, reject) => listener.once('error', reject).listen(originalPath, resolve));
    renameSync(originalPath, socketPath);
  } finally {
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  }
  const capabilityId = randomBytes(32).toString('hex');
  saveFlow('broker-refusal', [
    { tool: 'redeem', args: { capabilityId } },
    { tool: 'done', args: { value: 'unverified' } },
  ]);
  const result = await replayFlow(loadFlow('broker-refusal'), (_tool, args) => redeemCapability(args.capabilityId));
  report.result = { success: result.success, failedAtStep: result.failedAtStep,
    error: String(result.error), code: result.error?.code, cause: result.error?.cause?.code };
  assert.equal(result.success, false);
  assert.equal(result.failedAtStep, 0);
  assert.equal(result.error.code, 'CAPABILITY_TRANSPORT_FAILED');
  assert.equal(result.error.cause.code, 'ECONNREFUSED');
});
