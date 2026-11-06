// The fingerprint a launched browser presents: one fingerprint-generator
// sample for the target system and engine (of the persona's screen size when
// a persona is given), the persona's own device and locale laid over it, and,
// when the target system is the host's, the host's real hardware, since the
// real silicon leaks through the WebGL pixel hash whatever is claimed.

import { FingerprintGenerator } from 'fingerprint-generator';
import type { BrowserName, OperatingSystem } from 'header-generator';
import { toConfig } from '../../../fingerprint.js';
import type { HostHardware } from '../../../runtime/host_hardware.js';
import type { Persona } from '../../persona.js';
import type { RuntimeFingerprintConfig } from '../support.js';
import { honestScreenEnabled } from './window.js';

/** The persona's GPU strings as Gecko reports them: the renderer without Chromium's ANGLE wrapper, the vendor without Google's. */
function geckoGpu(gpu: Persona['gpu']): { vendor: string; renderer: string } {
  return {
    vendor: gpu.vendor.replace(/^Google Inc\. \((.+)\)$/, '$1'),
    renderer: gpu.renderer
      .replace(/^ANGLE \([^,]+, ANGLE Metal Renderer: ([^,]+).*\)$/, '$1')
      .replace(/^ANGLE \([^,]+, ([^,]+).*\)$/, '$1'),
  };
}

export function launchFingerprint(input: {
  targetOs: string;
  browserType: string;
  persona: Persona | undefined;
  userAgent: string | undefined;
  headless: boolean;
  /** The page's language: the persona's, else the launch's `locale`. */
  language?: string;
  /** The measured host surface, given only when the target system is the host's. */
  host?: HostHardware;
}): RuntimeFingerprintConfig {
  const { targetOs, browserType, persona, headless, host, language } = input;
  const isChromium = browserType === 'chromium';
  const size = persona?.screen;
  const sample = new FingerprintGenerator({
    // The dataset names Weles's Chromium family by its Chrome browser; the
    // generator refuses a family or system its dataset does not hold.
    browsers: [(isChromium ? 'chrome' : browserType) as BrowserName],
    operatingSystems: [targetOs as OperatingSystem],
    devices: ['desktop'],
    ...(size
      ? {
          screen: {
            minWidth: size.width,
            maxWidth: size.width,
            minHeight: size.height,
            maxHeight: size.height,
          },
        }
      : {}),
  }).getFingerprint();
  const fpConfig: RuntimeFingerprintConfig = toConfig(
    sample,
    targetOs,
    browserType,
  );
  // Allow callers to pin the HTTP + JS userAgent (e.g. to match a captcha
  // solver's UA so a returned clearance cookie stays valid).
  if (input.userAgent) fpConfig.navigator.userAgent = input.userAgent;

  if (language) {
    const n = fpConfig.navigator;
    n.language = language;
    // navigator.languages is [primary, bare language] when the primary has a
    // region tag, as real Firefox and Chrome expand it.
    const [bare] = language.split('-');
    n.languages = bare === language ? [language] : [language, bare];
  }

  if (persona) {
    const n = fpConfig.navigator;
    n.platform = persona.platform;
    n.hardwareConcurrency = persona.hardwareConcurrency;
    if (persona.deviceMemory) n.deviceMemory = persona.deviceMemory;
    fpConfig.screen = {
      ...fpConfig.screen,
      width: persona.screen.width,
      height: persona.screen.height,
    };
    fpConfig.window = {
      ...fpConfig.window,
      devicePixelRatio: persona.screen.dpr,
    };
    const gpu = isChromium ? persona.gpu : geckoGpu(persona.gpu);
    fpConfig.webgl = {
      ...fpConfig.webgl,
      vendor: isChromium ? 'Google Inc.' : 'Mozilla',
      renderer: gpu.renderer,
      unmaskedVendor: gpu.vendor,
      unmaskedRenderer: gpu.renderer,
    };
  }

  // Honest host (WELES_HONEST_HOST=0 opts out, e.g. cross-OS personas): when
  // the target OS is the host's, report what the same browser build measured
  // on this machine: its GPU strings, cores, memory and, with
  // WELES_HONEST_SCREEN, its display.
  if (host) {
    const n = fpConfig.navigator;
    n.hardwareConcurrency = host.cores;
    if (host.deviceMemory !== undefined) n.deviceMemory = host.deviceMemory;
    fpConfig.webgl = {
      ...fpConfig.webgl,
      renderer: host.glRenderer,
      unmaskedRenderer: host.glRenderer,
      unmaskedVendor: host.glUnmaskedVendor,
    };
    if (host.screen && honestScreenEnabled(headless)) {
      const sc = host.screen;
      fpConfig.screen = {
        ...fpConfig.screen,
        width: sc.width,
        height: sc.height,
        availWidth: sc.availWidth,
        availHeight: sc.availHeight,
        availTop: sc.availTop,
        colorDepth: sc.colorDepth,
        pixelDepth: sc.colorDepth,
      };
      fpConfig.window = { ...fpConfig.window, devicePixelRatio: sc.dpr };
    }
    // Carried to the cppConfig build for the platformVersion override.
    fpConfig._honestHost = host;
    console.log(
      `[async_api] honest-host: ${browserType} ${host.browserVersion} renderer=${JSON.stringify(host.glRenderer)} cores=${host.cores} memory=${host.deviceMemory} clientHints=${JSON.stringify(host.clientHints)}`,
    );
  }
  return fpConfig;
}
