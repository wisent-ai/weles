// The LinkedIn signup probe reads a hard challenge from the page's structure:
// a redirect to LinkedIn's checkpoint, or a frame or script a captcha vendor
// or that checkpoint serves. A vendor named only in the page's text or data
// attributes is no challenge, and a page that carries the signup form and no
// such source is accepted as the form.
//
// The probe runs as preflight runs it, through the built module, against the
// real https://www.linkedin.com/signup, through an HTTP CONNECT proxy this
// journey opens on the loopback, which records each tunnel it carries. The
// persona is a Chromium device Weles samples itself, so the host needs
// weles-chromium installed, as any run on Chromium does, and a route to
// LinkedIn.
//
// Usage: npm run build && node --test tests/proxy/linkedin-challenge.mjs
// Each run writes report.json under
// build/real-tests/proxy/linkedin-challenge-<stamp>/ with the source revision,
// the tunnels carried and the probe's verdict, markers and page.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acceptLanguageFor } from '../../dist/browser/persona.js';
import { sampleDevice } from '../../dist/browser/persona/device.js';
import { CAPTCHA_SOURCES } from '../../dist/captcha/vendors.js';
import { probeLinkedinSignup } from '../../dist/proxy/quality/platform_probes.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(
  root,
  'build',
  'real-tests',
  'proxy',
  `linkedin-challenge-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const report = {
  revision: spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim(),
  tunnels: [],
};

after(() => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'report.json'),
    `${JSON.stringify(report, null, '\t')}\n`,
  );
});

/** An HTTP CONNECT proxy on the loopback that records each tunnel it opens. */
async function connectProxy() {
  const proxy = createServer((_request, response) => {
    response.writeHead(405).end('this proxy carries CONNECT only\n');
  });
  proxy.on('connect', (request, client, head) => {
    const [host, port] = request.url.split(':');
    report.tunnels.push(request.url);
    const upstream = connect(Number(port), host, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (error) => {
      report.tunnelError = `${request.url}: ${error.message}`;
      client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    client.on('error', () => upstream.destroy());
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  return proxy;
}

test('the signup page is judged by its structure, through a real proxy', async () => {
  const proxy = await connectProxy();
  after(() => proxy.close());
  const device = sampleDevice({ browser: 'chromium' });
  const persona = {
    ...device,
    acceptLanguage: acceptLanguageFor('chromium', 'en-US'),
  };
  report.persona = persona;
  const probe = await probeLinkedinSignup(
    `http://127.0.0.1:${proxy.address().port}`,
    persona,
  );
  report.result = probe.result;
  report.error = probe.error;
  report.transport = probe.transport;
  report.bodyMarkers = probe.body_markers;
  report.page = probe.response_body?.text;

  assert.deepEqual(
    report.tunnels,
    ['www.linkedin.com:443'],
    'the probe went through the proxy',
  );
  assert.equal(
    probe.error,
    undefined,
    `the probe fetched the page: ${probe.error}`,
  );
  const markers = probe.body_markers;
  assert.equal(
    markers.hard_challenge,
    markers.checkpoint_redirect || markers.challenge_sources.length > 0,
    'a hard challenge is a checkpoint redirect or a challenge source',
  );
  const vendorMarkers = Object.values(CAPTCHA_SOURCES).flat();
  for (const source of markers.challenge_sources) {
    assert.ok(
      new URL(source).pathname.startsWith('/checkpoint/') ||
        vendorMarkers.some((marker) => source.includes(marker)),
      `${source} is a checkpoint page or a captcha vendor's widget`,
    );
  }
  // A vendor the page only names in its text or data attributes loads no
  // widget, so it is no challenge.
  const page = probe.response_body.text;
  const loaded = [
    ...page.matchAll(/<(?:iframe|script)\b[^>]*\ssrc\s*=[^>]*>/gi),
  ].map(([tag]) => tag);
  for (const marker of vendorMarkers) {
    if (page.includes(marker) && !loaded.some((tag) => tag.includes(marker))) {
      assert.ok(
        !markers.challenge_sources.some((source) => source.includes(marker)),
        `${marker} appears only in the page's text and is no challenge source`,
      );
    }
  }
  assert.equal(
    probe.result,
    markers.signup_form && !markers.hard_challenge
      ? 'form'
      : markers.hard_challenge
        ? 'challenge'
        : 'unknown',
    'the verdict follows the form and the challenge',
  );
});
