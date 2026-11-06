// A TikTok routing probe through an exit whose proxy refuses the connection
// fails naming curl's own failure, and neither the proxy URL nor the user or
// password it carries reaches the error the preflight prints and records
// (exit_preflight.ts writes describeError(error) to its log line and to
// rejected_reason, and describeError names every cause under the error).
//
// The probe runs as a run runs it: the built verifyTikTokRouting spawns the
// host's curl through a proxy URL with a user and a password. The proxy is a
// loopback port the operating system assigned and that was closed again, so
// the connection is refused before anything leaves the host.
//
// Usage: npm run build && node --test tests/proxy/tiktok-probe-redaction.mjs
// Each run writes report.json under build/real-tests/proxy/tiktok-probe-redaction-<stamp>/
// with the source revision, the proxy URL's port and the described error.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { describeError } from '../../dist/_shared/error-chain/index.cjs';
import { acceptLanguageFor } from '../../dist/browser/persona.js';
import { sampleDevice } from '../../dist/browser/persona/device.js';
import { verifyTikTokRouting } from '../../dist/proxy/quality/tiktok_routing.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(
  root,
  'build',
  'real-tests',
  'proxy',
  `tiktok-probe-redaction-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const report = {
  revision: spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim(),
  dirty: spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout,
};

after(() => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'report.json'),
    `${JSON.stringify(report, null, '\t')}\n`,
  );
});

/** A loopback port the operating system assigned and nothing listens on any more. */
async function closedLoopbackPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("a refused TikTok probe names curl's failure and none of the proxy credentials", async () => {
  const user = 'example-probe-user';
  const password = 'example probe/password';
  const port = await closedLoopbackPort();
  const proxyUrl = `http://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}`;
  report.port = port;

  // The probe presents the persona a run hands it; one it lacks is refused
  // before curl starts (tests/proxy/probe-persona.mjs).
  const persona = {
    ...sampleDevice({ browser: 'chromium' }),
    acceptLanguage: acceptLanguageFor('chromium', 'en-US'),
  };
  const thrown = await verifyTikTokRouting(proxyUrl, persona).then(
    (route) =>
      assert.fail(
        `the probe through a refused proxy answered ${JSON.stringify(route)}`,
      ),
    (error) => error,
  );
  const described = describeError(thrown);
  report.described = described;

  assert.match(
    described,
    /^tiktok routing probe through the exit failed: Command failed: curl /,
  );
  assert.match(described, /\[proxy-url\]/);
  assert.match(described, new RegExp(`127\\.0\\.0\\.1 port ${port}`));
  for (const secret of [
    proxyUrl,
    user,
    password,
    encodeURIComponent(user),
    encodeURIComponent(password),
  ]) {
    assert.equal(
      described.includes(secret),
      false,
      `the described error holds ${secret}: ${described}`,
    );
  }
});
