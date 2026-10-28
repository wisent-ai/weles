/**
 * Persona-based fingerprint rotation.
 *
 * A Persona is one coherent device and locale a browser session presents.
 * Each signup uses one Persona; its fields stay stable across the session.
 * The next signup picks a different Persona so TikTok-style anti-abuse
 * (which keys on device fingerprint) sees different devices instead of
 * "same device with rotating IPs".
 *
 * The device comes from one fingerprint-generator sample (persona/device.ts),
 * so its screen, GPU and cores are a combination real traffic carries; the
 * timezone and language come from the country the browser exits through
 * (persona/locale.ts), never from a default.
 */

import { randomUUID } from 'node:crypto';
import { FingerprintGenerator } from 'fingerprint-generator';
import type { OperatingSystem } from 'header-generator';
import { selectedBrowserVersion } from '../session/find_browser.js';
import {
  type PersonaBrowser,
  type PersonaDevice,
  type PersonaOs,
  sampleDevice,
} from './persona/device.js';
import { type ExitGeography, personaLocale } from './persona/locale.js';

export type { PersonaDevice } from './persona/device.js';

export interface Persona extends PersonaDevice {
  timezone: string;
  language: string;
  // Browser-correct Accept-Language header. Real Chrome on an en-US install
  // sends 'en-US,en;q=0.9'; real Firefox sends 'en-US,en;q=0.5' (Mozilla
  // intl.accept_languages). Threaded into Playwright extraHTTPHeaders so the
  // wire value matches what the corresponding real browser emits.
  acceptLanguage: string;
  // The persona's identity a cookie jar is bound to; personas written before
  // it became a UUID carry a number.
  canvasSeed: string | number;
}

/**
 * The Accept-Language `browser` sends for `language`: the language, then
 * its base language weighted ';q=0.9' as Chrome adds to its --lang flag, or
 * ';q=0.5' as Firefox's intl.accept_languages pref gives it.
 */
export function acceptLanguageFor(
  browser: PersonaBrowser | (string & {}),
  language: string,
): string {
  const [base] = language.split('-');
  return browser === 'firefox'
    ? `${language},${base};q=0.5`
    : `${language},${base};q=0.9`;
}

/**
 * `device` dressed in the locale of the country it exits through: `exit`'s
 * country (and its observed timezone), else the country the run states.
 * Refused by name when neither names a country the locale table holds.
 */
export function dressPersona(
  device: PersonaDevice,
  exit: ExitGeography,
): Persona {
  const locale = personaLocale(exit);
  const acceptLanguage = acceptLanguageFor(device.browser, locale.language);
  console.log(
    `[persona] os=${device.os} browser=${device.browser} gpu=${JSON.stringify(device.gpu.renderer)} screen=${device.screen.width}x${device.screen.height}@${device.screen.dpr} country=${locale.country} tz=${locale.timezone} lang=${locale.language}`,
  );
  return {
    ...device,
    timezone: locale.timezone,
    language: locale.language,
    acceptLanguage,
    canvasSeed: randomUUID(),
  };
}

/**
 * A coherent Persona for a browser exiting in `country`: a device sampled for
 * the forced `os` and `browser` (the dataset's shares otherwise), in that
 * country's locale. A caller that knows no exit country passes none; the
 * run's stated WELES_PERSONA_COUNTRY is then used, or the persona is refused.
 */
export function generatePersona(opts: {
  country?: string;
  os?: PersonaOs;
  browser?: PersonaBrowser;
}): Persona {
  return dressPersona(sampleDevice(opts), { country: opts.country });
}

export interface FirefoxNav {
  userAgent: string;
  appVersion: string;
  oscpu: string;
  vendor: '';
  product: string;
  productSub: string;
}

/**
 * Desktop-Firefox navigator surface for `targetOs`, sampled from the dataset
 * and carrying the selected weles-firefox release's major version. The
 * dataset's Firefox version is its own, not the installed binary's, and a UA
 * that disagrees with the Gecko engine is the signal Google ("this browser or
 * app may not be secure") and Cloudflare flag.
 */
export function firefoxNav(targetOs: string): FirefoxNav {
  const release = selectedBrowserVersion('firefox');
  const major = release.match(/^(?<major>\d+)\./)?.groups?.major;
  if (!major)
    throw new Error(
      `persona_firefox_version_unreadable: the selected weles-firefox release ${JSON.stringify(release)} names no major version`,
    );
  const nav = new FingerprintGenerator({
    browsers: ['firefox'],
    // The generator refuses a system its dataset does not hold.
    operatingSystems: [targetOs as OperatingSystem],
    devices: ['desktop'],
  }).getFingerprint().fingerprint.navigator;
  return {
    userAgent: nav.userAgent
      .replace(/rv:\d+/, `rv:${major}`)
      .replace(/Firefox\/\d+/, `Firefox/${major}`),
    appVersion: nav.appVersion,
    oscpu: nav.oscpu,
    vendor: '',
    product: nav.product,
    productSub: nav.productSub,
  };
}
