// One measurement of the host surface: the same browser build Weles will run,
// launched with no fingerprint configuration, reads its own WebGL strings,
// navigator, client hints and screen from an empty page in a secure context.

import { chromium, firefox, type Browser, type BrowserType } from 'playwright';
import type {
  HostClientHints,
  HostHardware,
  HostHardwareRequest,
  HostScreen,
} from '../../../runtime/host_hardware.js';

interface PageReading {
  webgl: { vendor: string; renderer: string } | null;
  cores: number;
  deviceMemory?: number;
  clientHints?: Partial<HostClientHints>;
  screen: Omit<HostScreen, 'dpr' | 'availTop'> & { availTop?: number };
  dpr: number;
}

function engine(browserType: string): BrowserType {
  if (browserType === 'chromium') return chromium;
  if (browserType === 'firefox') return firefox;
  throw new Error(
    `WELES_HONEST_HOST_PROBE_ENGINE: honest host has no probe for browser engine ${browserType}`,
  );
}

// The page the surface is read from. navigator.userAgentData, which carries
// the client hints, exists only in a secure context
// (https://wicg.github.io/ua-client-hints/#interface), and the about:blank a
// new page opens on was observed to give none, so the page is an HTTPS
// address under the reserved .invalid domain (RFC 6761) that the browser is
// answered locally: nothing leaves the host.
const PROBE_PAGE = 'https://weles-host-probe.invalid/';

async function openProbePage(browser: Browser, subject: string) {
  const page = await browser.newPage();
  await page.route(PROBE_PAGE, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>weles host probe</title>',
    }),
  );
  try {
    await page.goto(PROBE_PAGE);
  } catch (error) {
    throw new Error(
      `WELES_HONEST_HOST_PROBE_PAGE: ${subject} did not open the local probe page ${PROBE_PAGE}: ${(error as Error).message}`,
    );
  }
  return page;
}

/** Runs in the probe page: what the unconfigured browser reports about its host. */
async function readSurface(): Promise<PageReading> {
  const gl = document.createElement('canvas').getContext('webgl');
  const debug = gl?.getExtension('WEBGL_debug_renderer_info');
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    userAgentData?: {
      getHighEntropyValues(
        hints: string[],
      ): Promise<Partial<HostClientHints>>;
    };
  };
  // Gecko exposes neither client hints nor deviceMemory; both stay absent.
  const hints = await nav.userAgentData?.getHighEntropyValues([
    'platformVersion',
    'architecture',
    'bitness',
  ]);
  const shown = screen as Screen & { availTop?: number };
  return {
    webgl:
      gl && debug
        ? {
            vendor: String(gl.getParameter(debug.UNMASKED_VENDOR_WEBGL)),
            renderer: String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)),
          }
        : null,
    cores: nav.hardwareConcurrency,
    deviceMemory: nav.deviceMemory,
    clientHints: hints,
    screen: {
      width: shown.width,
      height: shown.height,
      availWidth: shown.availWidth,
      availHeight: shown.availHeight,
      availTop: shown.availTop,
      colorDepth: shown.colorDepth,
    },
    dpr: devicePixelRatio,
  };
}

function measuredScreen(reading: PageReading, subject: string): HostScreen {
  const { availTop } = reading.screen;
  if (availTop === undefined)
    throw new Error(
      `WELES_HONEST_HOST_PROBE_SCREEN: ${subject} reported no screen.availTop, so the host display is unmeasured`,
    );
  return { ...reading.screen, availTop, dpr: reading.dpr };
}

/** Chromium's measured client hints, each one named when the browser withheld it. */
function measuredClientHints(
  reading: PageReading,
  subject: string,
): HostClientHints {
  const hints = reading.clientHints;
  if (!hints?.platformVersion || !hints.architecture || !hints.bitness)
    throw new Error(
      `WELES_HONEST_HOST_PROBE_CLIENT_HINTS: ${subject} answered client hints ${JSON.stringify(hints)}, which lack platformVersion, architecture or bitness`,
    );
  const { platformVersion, architecture, bitness } = hints;
  return { platformVersion, architecture, bitness };
}

export async function probeHostHardware(
  request: HostHardwareRequest & { osFamily: string },
): Promise<HostHardware> {
  const { browserType, executablePath, withScreen, osFamily } = request;
  const subject = `${browserType} at ${executablePath}`;
  const launcher = engine(browserType);
  let browser: Browser;
  try {
    browser = await launcher.launch({
      executablePath,
      headless: !withScreen,
    });
  } catch (error) {
    throw new Error(
      `WELES_HONEST_HOST_PROBE_LAUNCH: ${subject} did not start ${withScreen ? 'headed' : 'headless'} to measure the host: ${(error as Error).message}`,
    );
  }
  try {
    const page = await openProbePage(browser, subject);
    const reading = await page.evaluate(readSurface);
    if (!reading.webgl)
      throw new Error(
        `WELES_HONEST_HOST_PROBE_WEBGL: ${subject} gave no WebGL context or no WEBGL_debug_renderer_info, so the host GPU is unmeasured`,
      );
    return {
      osFamily,
      browserVersion: browser.version(),
      cores: reading.cores,
      deviceMemory: reading.deviceMemory,
      ...(browserType === 'chromium'
        ? { clientHints: measuredClientHints(reading, subject) }
        : {}),
      glUnmaskedVendor: reading.webgl.vendor,
      glRenderer: reading.webgl.renderer,
      ...(withScreen ? { screen: measuredScreen(reading, subject) } : {}),
    };
  } finally {
    await browser.close();
  }
}
