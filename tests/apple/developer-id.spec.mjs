import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setInterval as every } from 'node:timers/promises';

const RESULT_POLL_MS = 5_000;
const CAPABILITY_MINUTES = 15;
const MINUTE_MS = 60_000;

const repo = resolve(process.env.PROBIERZ_APP_SOURCE || fileURLToPath(new URL('../../', import.meta.url)));
const artifacts = resolve(process.env.PROBIERZ_ARTIFACTS);
const tracePath = join(artifacts, 'apple-developer-id.trace.json');
const trace = { schemaVersion: 1, kind: 'probierz-apple-developer-id', startedAt: new Date().toISOString(), status: 'running', commands: [] };
mkdirSync(artifacts, { recursive: true });

function retainTrace() {
  writeFileSync(tracePath, `${JSON.stringify(trace, null, 2)}\n`, { mode: 0o600 });
}

function command(program, args, options = {}) {
  const number = trace.commands.length + 1;
  const startedAt = new Date().toISOString();
  const result = spawnSync(program, args, {
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
    ...options,
  });
  const stdoutPath = join(artifacts, `${number}.stdout.log`);
  const stderrPath = join(artifacts, `${number}.stderr.log`);
  writeFileSync(stdoutPath, result.stdout || '', { mode: 0o600 });
  writeFileSync(stderrPath, result.stderr || '', { mode: 0o600 });
  trace.commands.push({ program, args, startedAt, completedAt: new Date().toISOString(), exitCode: result.status, signal: result.signal, error: result.error?.message || null, stdoutPath, stderrPath });
  retainTrace();
  return result;
}

function successful(result, operation) {
  assert.equal(result.error, undefined, `${operation}: ${result.error?.message}`);
  assert.equal(result.status, 0, `${operation}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

retainTrace();
if (process.env.PROBIERZ_MEDIA_MANIFEST) {
  mkdirSync(dirname(process.env.PROBIERZ_MEDIA_MANIFEST), { recursive: true });
  writeFileSync(process.env.PROBIERZ_MEDIA_MANIFEST, JSON.stringify([
    { kind: 'trace', file: tracePath, contentType: 'application/json' },
  ]));
}

try {
  const accountItem = process.env.WELES_APPLE_ACCOUNT_ITEM;
  assert.match(accountItem || '', /^weles-apple-[a-z0-9][a-z0-9-]{0,126}-account$/, 'WELES_APPLE_ACCOUNT_ITEM must identify a real registered Apple Account Holder');
  const executionHost = process.env.WELES_APPLE_EXECUTION_HOST;
  assert.equal(executionHost, 'charless-mac-mini', 'This journey executes the browser only on the dedicated Mac mini');
  assert.equal(hostname().toLowerCase(), 'charless-mac-mini.local', 'The Probierz journey itself must be placed on the dedicated Mac mini');
  const stado = process.env.WELES_STADO_BIN || successful(command('/usr/bin/which', ['stado']), 'locating Stado').trim();
  const childEnv = { ...process.env, WELES_STADO_BIN: stado };
  trace.stadoVersion = successful(command(stado, ['--version']), 'reading Stado source identity').trim();
  trace.stadoSha256 = digest(readFileSync(stado));
  trace.skarbiecRelease = JSON.parse(successful(command(stado, ['release', 'active-binary', 'skarbiec', '--json']), 'reading the active Skarbiec release'));
  successful(command('npm', ['ci', '--no-audit', '--no-fund'], { cwd: repo, timeout: 300_000 }), 'installing the pinned Weles dependencies');
  successful(command('npm', ['run', 'build'], { cwd: repo, timeout: 300_000 }), 'building the pinned Weles source');
  const workRoot = join(homedir(), '.stado', 'work');
  mkdirSync(workRoot, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(workRoot, 'weles-apple-developer-id-'));
  const keyPath = join(work, 'private-key.pem');
  const certificatePath = join(work, 'certificate.cer');
  trace.retainedWork = work;
  retainTrace();
  const cli = join(repo, 'dist', 'cli.js');
  const args = [cli, 'apple-developer-id', '--account-item', accountItem, '--confirm', 'AUTHORIZE ONE APPLE DEVELOPER ID', '--execution-host', executionHost, '--execution-agent', 'weles-worker', '--expires-in-minutes', String(CAPABILITY_MINUTES), '--private-key-out', keyPath];

  const malformed = [...args];
  malformed[3] = 'not-an-apple-account';
  const refused = command(process.execPath, malformed, { env: childEnv });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /--account-item must name an Apple Skarbiec login item/);
  assert.equal(existsSync(keyPath), false, 'A refused account must not create a private key');

  // Exactly one authorized issuance attempt; a failure is retained, never retried here.
  const started = JSON.parse(successful(command(process.execPath, args, { env: childEnv }), 'starting the real Apple Developer ID issuance'));
  trace.started = started;
  retainTrace();
  assert.equal(started.status, 'running');
  assert.equal(started.execution_host, executionHost);
  assert.equal(started.account_item, accountItem);

  const deadline = Date.now() + CAPABILITY_MINUTES * MINUTE_MS;
  let result = null;
  for await (const _ of every(RESULT_POLL_MS)) {
    result = JSON.parse(successful(command(process.execPath, [cli, 'apple-developer-id', '--run', started.run, '--certificate-out', certificatePath], { env: childEnv }), 'reading the Apple Developer ID run'));
    if (result.status !== 'running' || Date.now() > deadline) break;
  }
  trace.result = result;
  retainTrace();
  assert.equal(result.status, 'issued', `The run must issue a certificate: ${JSON.stringify(result)}`);
  assert.equal(result.two_factor?.authorization_id, started.guard_id, 'The accepted code must belong to this authorization');
  assert.equal(result.two_factor?.source, 'capability', 'The code must be redeemed through Skarbiec');
  assert.equal(result.two_factor?.provider_accepted, true, 'Filling a code is not proof that Apple accepted it');

  const certificateBytes = readFileSync(certificatePath);
  const keyBytes = readFileSync(keyPath);
  const certificate = new X509Certificate(certificateBytes);
  assert.match(certificate.subject, /CN=Developer ID Application:/);
  assert.match(certificate.issuer, /CN=Developer ID Certification Authority/);
  assert.equal(certificate.checkPrivateKey(createPrivateKey(keyBytes)), true, 'The issued certificate must match the retained private key');
  assert.ok(Date.parse(certificate.validFrom) <= Date.now() && Date.now() < Date.parse(certificate.validTo), 'Apple must issue a currently valid certificate');
  writeFileSync(join(artifacts, 'certificate.cer'), certificateBytes, { mode: 0o644 });
  trace.certificate = { sha256: digest(certificateBytes), fingerprint256: certificate.fingerprint256, subject: certificate.subject, issuer: certificate.issuer, validFrom: certificate.validFrom, validTo: certificate.validTo };
  retainTrace();

  const duplicate = command(process.execPath, args, { env: childEnv });
  assert.equal(duplicate.status, 1);
  assert.match(duplicate.stderr, /refusing to replace an existing private key/);
  assert.equal(digest(readFileSync(keyPath)), digest(keyBytes), 'A duplicate issuance request must preserve the private key');
  trace.status = 'completed';
  console.log(JSON.stringify({ run: started.run, certificateSha256: trace.certificate.sha256, twoFactor: result.two_factor, retainedWork: work }));
} catch (error) {
  trace.status = 'failed';
  trace.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  trace.completedAt = new Date().toISOString();
  trace.observation = { reply: trace.error || `Apple accepted the Skarbiec-backed second factor and issued ${trace.certificate.fingerprint256}` };
  retainTrace();
}
