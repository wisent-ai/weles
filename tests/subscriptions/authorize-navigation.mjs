import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { constants as http } from 'node:http2';
import { hostname } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gotoAuthorize } from '../../src/trajectories/codex/google_sso/navigation/authorize.mjs';

// Execute only on the Stado-selected dedicated Weles host after building it.
// The real browser exercises HTTP navigation, not a simulated identity provider.
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(root, 'build/real-tests/authorize-navigation', randomUUID());
mkdirSync(directory, { recursive: true });
const report = {
  command: [process.execPath, ...process.execArgv, ...process.argv],
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  host: hostname(),
  scope: 'managed_browser_authorization_navigation_only',
  provider_sign_in: 'not_run',
  status: 'blocked',
  cases: [],
  recordings: join(directory, 'recordings'),
};
const save = () => writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
process.once('exit', (code) => {
  report.exit_status = code;
  save();
});
save();

await test('authorization navigation follows observed replacements, not error wording', async () => {
  let session;
  const pending = Promise.withResolvers();
  const server = createServer((request, response) => {
    if (request.url === '/pending') {
      pending.resolve();
      return;
    }
    if (request.url === '/redirect') {
      response.writeHead(http.HTTP_STATUS_FOUND, { Location: '/landing' });
      response.end();
      return;
    }
    if (request.url === '/download') {
      response.setHeader('Content-Disposition', 'attachment; filename="navigation.txt"');
      response.end('An attachment is not an authorization redirect.');
      return;
    }
    if (request.url === '/disconnect') {
      request.socket.destroy();
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Navigation boundary</title><main id="landed">Settled document</main>');
  });
  try {
    assert.ok(!process.env.WELES_STANDALONE, 'Stado placement must remain enforced');
    assert.ok(!process.env.ACCOUNT_ID, 'do not use an existing account profile');
    assert.ok(!process.env.ACTION_LOG_ID, 'do not attach to an existing worker run');
    const listening = once(server, 'listening');
    server.listen(); // The operating system assigns the listening port.
    await listening;
    const origin = `http://localhost:${server.address().port}`;
    process.env.WELES_RECORDINGS_ROOT = report.recordings;
    process.env.WELES_RUN_ID = randomUUID();
    const { WSession } = await import('../../dist/session/wsession.js');
    session = await WSession.start({
      label: 'authorize-navigation', operatorCdp: false,
      userDataDir: join(directory, 'profile'), record: true,
    });
    const page = session.page;
    report.status = 'failed';
    report.browser = await page.evaluate(() => navigator.userAgent);
    const marks = [];
    const mark = (stage) => marks.push(stage);
    const listeners = () => ({ request: page.listenerCount('request'), navigation: page.listenerCount('framenavigated') });
    const baseline = listeners();
    for (const route of ['/landing', '/redirect']) {
      await gotoAuthorize(page, origin + route, mark);
      assert.equal(page.url(), origin + '/landing');
      assert.equal(await page.locator('#landed').textContent(), 'Settled document');
      assert.deepEqual(listeners(), baseline, 'listeners are removed after success');
      report.cases.push({ route, outcome: 'settled', screenshot: await session.screenshot('navigation-success') });
    }
    const interrupted = gotoAuthorize(page, origin + '/pending', mark).then(
      () => ({ outcome: 'settled' }),
      (error) => ({ outcome: 'failed', error: { name: error.name, message: error.message } }),
    );
    await pending.promise;
    await page.goto(origin + '/landing', { waitUntil: 'commit' });
    const replacement = await interrupted;
    report.cases.push({ route: '/pending', ...replacement });
    assert.equal(replacement.outcome, 'settled', JSON.stringify(replacement));
    assert.deepEqual(marks, ['authorize_redirected']);
    assert.equal(page.url(), origin + '/landing');
    assert.deepEqual(listeners(), baseline);
    for (const route of ['/download', '/disconnect']) {
      const before = [...marks];
      await assert.rejects(gotoAuthorize(page, origin + route, mark), (error) => {
        report.cases.push({ route, outcome: 'refused', error: { name: error.name, message: error.message } });
        return error instanceof Error;
      });
      assert.deepEqual(marks, before, 'failure is not reported as a redirect');
      assert.deepEqual(listeners(), baseline, 'listeners are removed after refusal');
    }
    await page.close();
    await assert.rejects(gotoAuthorize(page, origin + '/landing', mark));
    assert.deepEqual(listeners(), baseline);
    report.cases.push({ route: '/landing', state: 'page_closed', outcome: 'refused' });
    report.status = 'passed';
  } catch (error) {
    report.error = { name: error.name, message: error.message, stack: error.stack };
    throw error;
  } finally {
    try {
      if (session) await session.close();
    } catch (error) {
      report.status = 'failed';
      report.close_error = { name: error.name, message: error.message };
      throw error;
    } finally {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      save();
      console.log(`authorize-navigation report: ${join(directory, 'report.json')}`);
    }
  }
});
