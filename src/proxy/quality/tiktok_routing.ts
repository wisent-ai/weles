// The region TikTok routes a candidate exit to, read from the signup
// document's SIGI_STATE before any browser is bound to the exit. The page
// is fetched through the exit with the headers the run's persona sends
// (`probeHeaders`), so the verdict tracks the browser that will use it.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  type LinkedInProbePersona,
  probeHeaders,
} from './platform_probes.js';

export type RoutingResult = 'standard' | 'high_risk' | 'unknown';

const SIGNUP_URL = 'https://www.tiktok.com/signup';
/** The routing region TikTok writes into the signup document. */
const VREGION = /"vregion":"([A-Z0-9-]+)"/;
/** The region suffix TikTok gives its high-risk cluster. */
const HIGH_RISK = /-TTP2$/i;

/**
 * The region one fetch of the signup page through `proxyUrl` names, or null
 * when the page names none. A curl that fails throws with curl's own words
 * (the proxy URL withheld), so the preflight records why the exit was not
 * judged instead of an unknown route.
 */
async function probeOnce(
  proxyUrl: string,
  persona: LinkedInProbePersona | undefined,
): Promise<string | null> {
  const headers = probeHeaders(persona);
  const args = [
    '-sS',
    '--compressed',
    '-x',
    proxyUrl,
    ...Object.entries(headers).flatMap(([name, value]) => [
      '-H',
      `${name}: ${value}`,
    ]),
    SIGNUP_URL,
  ];
  try {
    const { stdout } = await promisify(execFile)('curl', args, {
      encoding: 'utf8',
      maxBuffer: Infinity,
    });
    const found = VREGION.exec(stdout);
    return found ? found[1] : null;
  } catch (error) {
    // curl's failure names its whole command line, the proxy credentials
    // with it, so only the redacted words leave: the raw error is not kept
    // as the cause, where an error-chain printer would show it.
    const said = error instanceof Error ? error.message : String(error);
    throw new Error(
      `tiktok routing probe through the exit failed: ${said.replaceAll(proxyUrl, '[proxy-url]')}`,
    );
  }
}

/**
 * Whether TikTok routes the exit to its standard cluster. Two fetches, since
 * a sticky session can rotate its exit between requests: either naming no
 * region is unknown, either naming the high-risk cluster or the two naming
 * different regions is high risk.
 */
export async function verifyTikTokRouting(
  proxyUrl: string,
  persona?: LinkedInProbePersona,
): Promise<{ result: RoutingResult; vregion?: string }> {
  if (!proxyUrl) return { result: 'unknown' };
  const first = await probeOnce(proxyUrl, persona);
  if (!first) return { result: 'unknown' };
  if (HIGH_RISK.test(first)) return { result: 'high_risk', vregion: first };
  const second = await probeOnce(proxyUrl, persona);
  if (!second) return { result: 'unknown', vregion: first };
  if (first !== second)
    return { result: 'high_risk', vregion: `${first}!=${second}` };
  if (HIGH_RISK.test(second)) return { result: 'high_risk', vregion: second };
  return { result: 'standard', vregion: first };
}
