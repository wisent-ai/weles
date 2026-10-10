import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { keeperRequest } from '../../src/trajectories/_shared/keeper/client.mjs';
import { keeperControl } from './control.mjs';

// Run on the Stado-selected dedicated Weles host after the product build.
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(root, 'build/real-tests/keeper', randomUUID());
mkdirSync(directory, { recursive: true });
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  command: [process.execPath, ...process.execArgv, ...process.argv],
  host: hostname(),
  status: 'blocked',
  commands: [],
};
const save = () =>
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
process.once('exit', (code) => {
  report.exit_status = code;
  save();
});
save();

await test('keeper serves humanized fill, clear, click and explicit action refusals', async () => {
  assert.ok(
    !process.env.WELES_STANDALONE,
    'Stado placement must remain enforced',
  );
  assert.ok(
    !process.env.ACCOUNT_ID,
    'the test must not use an operator account profile',
  );
  assert.ok(
    !process.env.ACTION_LOG_ID,
    'the test must not attach to an existing run',
  );
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(
      '<!doctype html><title>Keeper input journey</title><label>Value<input id="value"></label><button id="save" onclick="document.querySelector(\'#saved\').textContent=document.querySelector(\'#value\').value">Save</button><output id="saved"></output>',
    );
  });
  let child;
  let exited;
  let lines;
  try {
    const listening = once(server, 'listening');
    server.listen();
    await listening;
    const origin = `http://localhost:${server.address().port}`;
    const session = `keeper-test-${randomUUID()}`;
    const binary = process.env.WELES_BIN;
    assert.ok(
      binary,
      'WELES_BIN must name the built Weles executable on the selected host',
    );
    child = spawn(
      binary,
      ['keeper', 'start', '--session', session, '--url', origin],
      {
        cwd: root,
        env: {
          ...process.env,
          WELES_RECORDINGS_ROOT: join(directory, 'recordings'),
          WELES_RUN_ID: randomUUID(),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      report.stderr = stderr;
      save();
    });
    const ready = Promise.withResolvers();
    exited = once(child, 'exit');
    exited.then(([code, signal]) => {
      report.keeper_exit = { code, signal };
      ready.reject(
        new Error(
          `keeper exited before readiness: ${code} ${signal}: ${stderr}`,
        ),
      );
    });
    child.once('error', ready.reject);
    lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      try {
        const value = JSON.parse(line);
        if (value.session === session && value.socket) ready.resolve(value);
      } catch (error) {
        report.last_non_json_output = { line, error: error.message };
      }
    });
    const address = await ready.promise;
    report.status = 'failed';
    report.keeper = address;
    const command = async (request) => {
      const answer = await keeperRequest(address.socket, request);
      report.commands.push({ request, answer });
      save();
      return answer;
    };
    const running = await keeperControl(
      binary,
      session,
      'status',
      root,
      report,
      save,
    );
    assert.equal(running.state, 'running');
    assert.equal(running.url, origin + '/');
    assert.equal((await command({ action: 'settle' })).url, origin + '/');
    assert.equal(
      (
        await command({
          action: 'fill',
          selector: '#value',
          text: 'Zachowaj żółć — 日本語',
        })
      ).ok,
      true,
    );
    assert.equal(
      (await command({ action: 'click', selector: '#save' })).ok,
      true,
    );
    assert.equal(
      (
        await command({
          action: 'eval',
          js: 'document.querySelector("#saved").textContent',
        })
      ).result,
      'Zachowaj żółć — 日本語',
    );
    assert.equal(
      (await command({ action: 'fill', selector: '#value', text: '' })).ok,
      true,
    );
    assert.equal(
      (
        await command({
          action: 'eval',
          js: 'document.querySelector("#value").value',
        })
      ).result,
      '',
    );
    const missing = await command({ action: 'fill', selector: '#value' });
    assert.equal(missing.ok, false);
    assert.match(missing.error, /string "text"/);
    const removed = await command({
      action: 'fill_fast',
      selector: '#value',
      text: 'must not be written',
    });
    assert.equal(removed.ok, false);
    assert.ok(removed.error.includes('fill_fast'));
    assert.equal(
      (
        await command({
          action: 'eval',
          js: 'document.querySelector("#value").value',
        })
      ).result,
      '',
    );
    const stopped = await keeperControl(
      binary,
      session,
      'stop',
      root,
      report,
      save,
    );
    assert.equal(stopped.state, 'stopped');
    const [exitCode, signal] = await exited;
    assert.equal(signal, null);
    assert.ifError(exitCode);
    assert.equal(existsSync(address.socket), false);
    assert.equal(
      (await keeperControl(binary, session, 'status', root, report, save))
        .state,
      'stopped',
    );
    const recordings = join(directory, 'recordings');
    const evidence = readdirSync(recordings, { recursive: true });
    const captchaReport = evidence.find((path) =>
      path.endsWith('captcha_events.json'),
    );
    assert.ok(
      captchaReport,
      'shutdown must finish the post-context-close evidence write',
    );
    assert.equal(
      JSON.parse(readFileSync(join(recordings, captchaReport), 'utf8'))
        .challenge_faced,
      false,
    );
    report.recordings = evidence;
    report.status = 'passed';
  } catch (error) {
    report.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
    throw error;
  } finally {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null)
      child.kill('SIGTERM');
    if (exited) await exited;
    server.closeAllConnections();
    if (server.listening) {
      const closed = Promise.withResolvers();
      server.close((error) =>
        error ? closed.reject(error) : closed.resolve(),
      );
      await closed.promise;
    }
    save();
  }
});
