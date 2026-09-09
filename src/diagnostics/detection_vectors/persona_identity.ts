/**
 * Which operating system and browser does a fingerprint claim to be?
 *
 * Three unrelated families need that answer before they can judge anything:
 * screen geometry (is a touch digitiser plausible on this OS?), cross-signal
 * consistency (does the GPU belong to the OS in the User-Agent?), and the
 * navigator family (is the baseline even comparable to the subject?). They
 * must all read the persona the same way, or two rules will disagree about
 * the same capture.
 *
 * These readers change when a persona changes — a new Chromium fork token, a
 * renamed platform string, an Apple Silicon variant — which has nothing to do
 * with why any individual rule's threshold changes. That is why they sit here
 * rather than beside their first caller.
 *
 * Note: this module is internal to the registry. The package root deliberately
 * does not re-export it; personas are an input to rules, not a public vector.
 */

export const OS_DESKTOP = new Set(['windows', 'linux', 'macos']);

export function osFromUA(ua: string): string | null {
  const u = ua.toLowerCase();
  if (u.includes('macintosh') || u.includes('mac os')) return 'macos';
  if (u.includes('windows nt')) return 'windows';
  if (u.includes('linux') || u.includes('x11')) return 'linux';
  return null;
}

export function platformFromNav(platform: string): string | null {
  const p = String(platform || '').toLowerCase();
  if (p.includes('mac') || p.includes('darwin')) return 'macos';
  if (p.includes('win')) return 'windows';
  if (p.includes('linux')) return 'linux';
  return null;
}

export function browserFromUA(ua: string): string | null {
  const u = ua.toLowerCase();
  if (u.includes('firefox') && !u.includes('seamonkey')) return 'firefox';
  if (u.includes('chrome') && !u.includes('edg') && !u.includes('opr')) return 'chrome';
  if (u.includes('safari') && !u.includes('chrome')) return 'safari';
  if (u.includes('edg')) return 'edge';
  return null;
}
