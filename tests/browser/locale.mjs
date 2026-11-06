// `weles open --locale <tag>` is the language the page reads: the actual CLI
// opens a page this test serves in the real browser; the page shows
// navigator.language and the Accept-Language header it was sent, and both
// must be the tag; without --locale they are not, and a tag that does not
// parse is refused as usage before any browser starts. Required: a built CLI
// (npm run build), the browser runtime `weles doctor` reports ready, and
// WELES_VIEWPORT.
//
//   node tests/browser/locale.mjs
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = join(root, 'build/real-tests/browser-locale', randomUUID());
mkdirSync(join(output, 'recordings'), { recursive: true });
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  runs: [],
  verdict: 'failed',
};
const save = () => writeFileSync(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
process.once('exit', save);

// The browser loads this page while the CLI runs, so the CLI is spawned
// without blocking: a synchronous spawn would stop this server answering.
const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><title>locale</title><p id="header">header ${request.headers['accept-language'] ?? 'none'}</p>
<p id="language"></p><script>document.getElementById('language').textContent = 'navigator ' + navigator.language;</script>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

function weles(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, 'dist/cli.js'), ...args], {
      env: { ...process.env, WELES_DISABLE_RECORDING: '1', WELES_RECORDINGS_ROOT: join(output, 'recordings') },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => {
      report.runs.push({ args, status, stdout, stderr: stderr.slice(-4000) });
      save();
      resolve({ status, stdout, stderr });
    });
  });
}

async function open(...extra) {
  const run = await weles(['open', url, '--headless', '--os', 'macos', '--browser', 'chromium',
    '--wait-for-text', 'navigator', '--text', '--json', ...extra]);
  assert.equal(run.status, 0, `weles open ${extra.join(' ')} failed: ${run.stderr.slice(-2000)}`);
  return JSON.parse(run.stdout).text;
}

try {
  const polish = await open('--locale', 'pl-PL');
  assert.match(polish, /navigator pl-PL/, `the page did not read pl-PL: ${polish}`);
  assert.match(polish, /header pl-PL,pl;q=0\.9/, `the page was not sent Accept-Language pl-PL: ${polish}`);
  const plain = await open();
  assert.doesNotMatch(plain, /navigator pl-PL/, 'without --locale the page still read pl-PL');
  const refused = await weles(['open', url, '--os', 'macos', '--browser', 'chromium', '--locale', 'not a tag']);
  assert.equal(refused.status, 2, `an invalid --locale was not refused as usage: ${refused.stderr}`);
  assert.match(refused.stderr, /--locale "not a tag" is not a BCP 47 language tag/);
  report.verdict = 'passed';
  console.log(`passed: ${join(output, 'report.json')}`);
} finally {
  server.close();
}
