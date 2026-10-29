// The honest host is measured, not composed: the selected Chromium release,
// started with no fingerprint configuration, reports this host's WebGL
// strings, cores, client hints and screen, and a Weles session whose target
// system is the host's presents exactly those values to its pages. A probe
// that cannot run refuses by name, and its failure is not kept, so the next
// request measures again.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AsyncNewBrowser } from '../../dist/async_api.js';
import {
  hostHardware,
  hostOsFamily,
} from '../../dist/runtime/host_hardware.js';
import { findCustomBrowser } from '../../dist/session/find_browser.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reports = join(root, 'build/real-tests/identity');
mkdirSync(reports, { recursive: true });
const directory = mkdtempSync(join(reports, 'honest-host-'));
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  command: [process.execPath, ...process.execArgv, ...process.argv],
  observed: {},
};
process.once('exit', (code) => {
  report.exit_status = code;
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
});

const chromiumPath = findCustomBrowser('chromium');
const hostOs = hostOsFamily();

/** What a page of the session reports about its host. */
function pageSurface() {
  const gl = document.createElement('canvas').getContext('webgl');
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    vendor: gl.getParameter(debug.UNMASKED_VENDOR_WEBGL),
    renderer: gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
    cores: navigator.hardwareConcurrency,
    screen: {
      width: screen.width,
      height: screen.height,
      availTop: screen.availTop,
      colorDepth: screen.colorDepth,
    },
  };
}

test('a host-system session presents the surface its own browser measured', async () => {
  assert.ok(chromiumPath, 'no selected Weles Chromium release on this host');
  assert.ok(hostOs, 'this host has no Weles system name');
  const measured = await hostHardware({
    browserType: 'chromium',
    executablePath: chromiumPath,
    withScreen: true,
  });
  report.observed.measured = measured;
  assert.equal(measured.osFamily, hostOs);
  assert.ok(measured.glRenderer, 'the probe measured no renderer');
  assert.ok(measured.clientHints, 'the probe measured no client hints');
  assert.ok(measured.screen, 'the headed probe measured no screen');

  const context = await AsyncNewBrowser({
    os: hostOs,
    browser: 'chromium',
    recordVideo: false,
  });
  try {
    const page = await context.newPage();
    // The session's surface is read where the probe reads the host's: an
    // HTTPS page under the reserved .invalid domain answered locally, since
    // navigator.userAgentData exists only in a secure context
    // (https://wicg.github.io/ua-client-hints/#interface) and the about:blank
    // a new page opens on gives none.
    const surfacePage = 'https://honest-host-session.invalid/';
    await page.route(surfacePage, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>honest host session</title>',
      }),
    );
    await page.goto(surfacePage);
    const seen = await page.evaluate(pageSurface);
    const hints = await page.evaluate(() =>
      navigator.userAgentData.getHighEntropyValues([
        'platformVersion',
        'architecture',
        'bitness',
      ]),
    );
    report.observed.session = { ...seen, hints };
    assert.equal(seen.renderer, measured.glRenderer);
    assert.equal(seen.vendor, measured.glUnmaskedVendor);
    assert.equal(seen.cores, measured.cores);
    assert.deepEqual(seen.screen, {
      width: measured.screen.width,
      height: measured.screen.height,
      availTop: measured.screen.availTop,
      colorDepth: measured.screen.colorDepth,
    });
    assert.equal(hints.platformVersion, measured.clientHints.platformVersion);
    assert.equal(hints.architecture, measured.clientHints.architecture);
    assert.equal(hints.bitness, measured.clientHints.bitness);
  } finally {
    await context.close();
  }
});

test('a browser that does not start refuses the measurement, every time', async () => {
  const missing = join(directory, 'no-such-browser');
  for (const attempt of ['first', 'second']) {
    await assert.rejects(
      hostHardware({
        browserType: 'chromium',
        executablePath: missing,
        withScreen: false,
      }),
      (error) => {
        report.observed[`refusal_${attempt}`] = error.message;
        return (
          error.message.startsWith('WELES_HONEST_HOST_PROBE_LAUNCH:') &&
          error.message.includes(missing)
        );
      },
    );
  }
});

test('an engine with no probe is refused by name', async () => {
  await assert.rejects(
    hostHardware({
      browserType: 'webkit',
      executablePath: chromiumPath,
      withScreen: false,
    }),
    /^Error: WELES_HONEST_HOST_PROBE_ENGINE: .*webkit/,
  );
});
