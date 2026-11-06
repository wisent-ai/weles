// The exit probes present only the persona the run hands them, with the
// browser version of the release the run launches: a probe asked with no
// persona, or with one that leaves out a field its headers need, is refused
// naming it; a sampled Chromium persona's operating system and language and
// the weles-chromium release's major version reach the headers, whether or
// not the sampled device carried a Chrome version of its own.
//
// The probes run as a run runs them, through the built modules: probeHeaders
// over a device Weles samples itself, probeLinkedinSignup and
// verifyTikTokRouting with no persona. Nothing is fetched: a refused persona
// ends each probe before curl starts. The host needs weles-chromium installed,
// as any run on Chromium does.
//
// Usage: npm run build && node --test tests/proxy/probe-persona.mjs
// Each run writes report.json under build/real-tests/proxy/probe-persona-<stamp>/
// with the source revision, the sampled persona and every refusal read.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { acceptLanguageFor } from '../../dist/browser/persona.js';
import { sampleDevice } from '../../dist/browser/persona/device.js';
import {
  probeHeaders,
  probeLinkedinSignup,
} from '../../dist/proxy/quality/platform_probes.js';
import { verifyTikTokRouting } from '../../dist/proxy/quality/tiktok_routing.js';
import { selectedBrowserVersion } from '../../dist/session/find_browser.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = join(
  root,
  'build',
  'real-tests',
  'proxy',
  `probe-persona-${new Date().toISOString().replace(/[:.]/g, '-')}`,
);
const report = {
  revision: spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).stdout.trim(),
};

after(() => {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'report.json'),
    `${JSON.stringify(report, null, '\t')}\n`,
  );
});

/** A Chromium persona as the browser launch samples and dresses it. */
function chromiumPersona() {
  const device = sampleDevice({ browser: 'chromium' });
  return { ...device, acceptLanguage: acceptLanguageFor('chromium', 'de-DE') };
}

test("a sampled Chromium persona's system and language and the release's version reach the probe headers", () => {
  const persona = chromiumPersona();
  report.persona = persona;
  const release = selectedBrowserVersion('chromium');
  report.chromiumRelease = release;
  const major = release.split('.')[0];
  const escaped = persona.userAgentOs.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const { chromeVersion, ...unversioned } = persona;
  report.sampledChromeVersion = chromeVersion;
  for (const sampled of [persona, unversioned]) {
    const headers = probeHeaders(sampled);
    const userAgent = headers['User-Agent'];
    assert.match(userAgent, new RegExp(`\\(${escaped}\\)`));
    assert.match(userAgent, new RegExp(`Chrome/${major}\\.0\\.0\\.0 `));
    assert.match(headers['sec-ch-ua'], new RegExp(`"Chromium";v="${major}"`));
    assert.equal(headers['Accept-Language'], persona.acceptLanguage);
  }
});

test('a probe asked with no persona, or one missing a field, is refused naming it', async () => {
  assert.throws(
    () => probeHeaders(undefined),
    /^Error: probe_persona_missing:/,
  );
  const { acceptLanguage, ...withoutLanguage } = chromiumPersona();
  report.removedAcceptLanguage = acceptLanguage;
  assert.throws(
    () => probeHeaders(withoutLanguage),
    /probe_persona_incomplete: .* names no acceptLanguage/,
  );
  const { userAgentOs, ...withoutSystem } = chromiumPersona();
  report.removedUserAgentOs = userAgentOs;
  assert.throws(
    () => probeHeaders(withoutSystem),
    /probe_persona_incomplete: .* names no userAgentOs/,
  );

  const linkedin = await probeLinkedinSignup('http://proxy.invalid', undefined);
  report.linkedin = linkedin;
  assert.equal(linkedin.result, 'unknown');
  assert.match(linkedin.error, /^probe_persona_missing:/);

  const tiktok = await verifyTikTokRouting('http://proxy.invalid').then(
    (route) => assert.fail(`no persona, yet answered ${JSON.stringify(route)}`),
    (error) => error,
  );
  report.tiktok = String(tiktok);
  assert.match(String(tiktok), /probe_persona_missing:/);
});
