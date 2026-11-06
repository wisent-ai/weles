// The navigation headers an exit probe fetches with: the ones the run's
// persona sends, so a probe's verdict tracks the browser that will use the
// exit. Every value comes from the persona, except the browser's version,
// which comes from the weles-chromium or weles-firefox release the run
// launches, as the launched browser's own User-Agent does (toCppConfig,
// firefoxNav); a persona that leaves a field out is refused naming it, never
// answered with a browser nobody runs.

import { selectedBrowserVersion } from '../../session/find_browser.js';

export type LinkedInProbePersona = {
  os?: 'macos' | 'windows' | 'linux' | string;
  browser?: 'chromium' | 'firefox' | 'webkit' | string;
  chromeVersion?: string;
  userAgentOs?: string;
  acceptLanguage?: string;
};

/** The `sec-ch-ua-platform` Chromium sends for each persona OS. */
const CH_PLATFORM: Readonly<Record<string, string>> = {
  macos: '"macOS"',
  windows: '"Windows"',
  linux: '"Linux"',
};

/** `field` of `persona`, or the refusal naming it. */
function stated(
  persona: LinkedInProbePersona,
  field: keyof LinkedInProbePersona,
): string {
  const value = persona[field];
  if (!value)
    throw new Error(
      `probe_persona_incomplete: the persona an exit probe presents names no ${field}, so the probe would send a browser the run does not use`,
    );
  return value;
}

/** The major version of a dotted browser version, or the refusal naming it. */
function major(version: string, of: string): string {
  const found = /^(?<major>\d+)\./.exec(version)?.groups?.major;
  if (!found)
    throw new Error(
      `probe_persona_version_unreadable: ${of} ${JSON.stringify(version)} names no major version`,
    );
  return found;
}

/** The navigation headers `persona` sends, for a probe fetched through an exit. */
export function probeHeaders(
  persona: LinkedInProbePersona | undefined,
): Record<string, string> {
  if (!persona)
    throw new Error(
      'probe_persona_missing: an exit probe was asked with no persona; its caller passes the device the run launches',
    );
  const browser = stated(persona, 'browser');
  const userAgentOs = stated(persona, 'userAgentOs');
  const acceptLanguage = stated(persona, 'acceptLanguage');
  if (browser === 'firefox') {
    const version = major(
      selectedBrowserVersion('firefox'),
      'the selected weles-firefox release',
    );
    return {
      'User-Agent': `Mozilla/5.0 (${userAgentOs}; rv:${version}.0) Gecko/20100101 Firefox/${version}.0`,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': acceptLanguage,
      'Upgrade-Insecure-Requests': '1',
    };
  }
  if (browser !== 'chromium')
    throw new Error(
      `probe_persona_browser_unknown: an exit probe has no navigation headers for browser ${JSON.stringify(browser)}`,
    );
  const os = stated(persona, 'os');
  const platform = CH_PLATFORM[os];
  if (!platform)
    throw new Error(
      `probe_persona_os_unknown: Chromium states no sec-ch-ua-platform for persona os ${JSON.stringify(os)}`,
    );
  const chrome = major(
    selectedBrowserVersion('chromium'),
    'the selected weles-chromium release',
  );
  return {
    'User-Agent': `Mozilla/5.0 (${userAgentOs}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Safari/537.36`,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': acceptLanguage,
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Priority: 'u=0, i',
    'sec-ch-ua': `"Google Chrome";v="${chrome}", "Not.A/Brand";v="8", "Chromium";v="${chrome}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': platform,
    'sec-fetch-dest': 'document',
    'sec-fetch-mode': 'navigate',
    'sec-fetch-site': 'none',
    'sec-fetch-user': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
}
