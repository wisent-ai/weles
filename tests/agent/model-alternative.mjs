// With no model route named (no WELES_MODEL_ENDPOINT, no
// STADO_MODEL_ROUTER_URL), Weles's model call goes to Stado's inference
// alternatives: the built `callJeden` against the real Stado WELES_TEST_STADO,
// first on PATH, in a home of the run's own whose service directory places
// Brama nowhere. Without a Stado it is refused naming the command; with it,
// refused with Stado's sentence (Brama's cause and the command that answers
// the kept request); a statement recorded for exactly that request then
// answers it, and Stado records the attestation alternative serving Weles.
// A named Brama that does not answer falls to the same alternatives.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reports = join(root, 'build/real-tests/agent');
mkdirSync(reports, { recursive: true });
const directory = mkdtempSync(join(reports, 'model-alternative-'));
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  command: [process.execPath, ...process.execArgv, ...process.argv],
  cases: [],
};
process.once('exit', (code) => {
  report.exit_status = code;
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
});

const stadoBinary = process.env.WELES_TEST_STADO;
assert.ok(stadoBinary, 'WELES_TEST_STADO names the real stado executable');
const home = join(directory, 'home');
const bin = join(directory, 'bin');
mkdirSync(home, { recursive: true });
mkdirSync(bin, { recursive: true });
const pathWithoutStado = (process.env.PATH ?? '')
  .split(':')
  .filter((entry) => {
    try {
      execFileSync('test', ['-x', join(entry, 'stado')]);
      return false;
    } catch {
      return true;
    }
  })
  .join(':');

for (const name of [
  'WELES_MODEL_ENDPOINT',
  'WELES_MODEL',
  'WELES_MODEL_KEY',
  'STADO_MODEL_ROUTER_URL',
  'WELES_STADO_MODEL_ROUTER_TOKEN',
  'WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET',
  'WELES_STADO_MODEL_ROUTER_AGENT_ID',
  'STADO_INFERENCE_ORDER',
  'STADO_ATTESTATIONS',
  'STADO_CAPABILITIES_RECORD',
  'STADO_CONFIG',
])
  delete process.env[name];
process.env.HOME = home;

const stado = (args, input = '') => {
  const out = execFileSync(join(bin, 'stado'), args, {
    encoding: 'utf8',
    input,
    env: { ...process.env, PATH: `${bin}:${pathWithoutStado}` },
  });
  report.cases.push({ stado: args });
  return out;
};

// One fresh module per state: the route is read once per process.
let loads = 0;
const freshCallJeden = async () =>
  (await import(`../../dist/agent/jeden.js?load=${++loads}`)).callJeden;

await test('without Stado the model call is refused naming the command', async () => {
  process.env.PATH = pathWithoutStado;
  const callJeden = await freshCallJeden();
  await assert.rejects(callJeden('Name the colour of the sky.'), (error) => {
    assert.match(
      error.message,
      /`stado capabilities call inference --consumer weles --json` could not run/,
    );
    return true;
  });
  report.cases.push('no-stado');
});

await test('Stado refuses, a recorded statement answers, and Stado records who served', async () => {
  symlinkSync(stadoBinary, join(bin, 'stado'));
  process.env.PATH = `${bin}:${pathWithoutStado}`;
  stado(['config', 'init']);
  const callJeden = await freshCallJeden();
  const prompt = 'Name the colour of a clear daytime sky.';
  await assert.rejects(callJeden(prompt), (error) => {
    assert.match(error.message, /no inference alternative answered `stado capabilities call inference --consumer weles --json`/);
    assert.match(error.message, /brama at /);
    assert.match(
      error.message,
      /stado capabilities attestation record inference --consumer weles/,
    );
    return true;
  });
  const [kept] = JSON.parse(
    stado(['capabilities', 'attestation', 'list', 'inference', '--consumer', 'weles', '--json']),
  );
  stado(
    [
      'capabilities',
      'attestation',
      'record',
      'inference',
      '--consumer',
      'weles',
      kept.request,
      '--checked',
      'a clear daytime sky is blue',
    ],
    'blue',
  );
  const answered = await callJeden(prompt);
  assert.equal(answered.raw, 'blue');
  assert.equal(
    answered.routerUrl,
    'stado capabilities call inference --consumer weles --json',
  );
  const listed = JSON.parse(stado(['capabilities', 'inference', '--json']));
  assert.equal(listed.alternatives[0].served.weles.provider, 'attestation');
  report.cases.push('attested');
});

await test("a named Brama that does not answer falls to Stado's alternatives", async () => {
  // A port that was free a moment ago: nothing answers on it.
  const port = await new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  process.env.STADO_MODEL_ROUTER_URL = `http://127.0.0.1:${port}`;
  process.env.WELES_STADO_MODEL_ROUTER_TOKEN = 'unanswered-bearer';
  process.env.WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET = 'unanswered-secret';
  process.env.WELES_STADO_MODEL_ROUTER_AGENT_ID = 'weles';
  const callJeden = await freshCallJeden();
  // The same request the statement above answers.
  const answered = await callJeden('Name the colour of a clear daytime sky.');
  assert.equal(answered.raw, 'blue');
  report.cases.push('named-brama-unanswered');
});
