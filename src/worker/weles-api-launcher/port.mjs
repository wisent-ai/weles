/**
 * Who already holds the API port, and whether that holder is a Weles at all.
 *
 * On 2026-09-21 this unit logged that the port was already served, once a
 * minute for hours, while Brama failed against that very port, because the
 * holder was never named and never asked what it was. It is asked now.
 */

/** The first listening process in an `lsof` listing, as `command pid (user)`. */
export function portHolder(listing) {
  const row = listing
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!row) return 'an unidentified process';
  const [command, pid, user] = row.split(/\s+/);
  return `${command} pid ${pid} (${user})`;
}

/**
 * What the process on this port says it is. A Weles answers `/healthz` with
 * its own source name; anything else - a forward, a stale build, another
 * product - is a stranger, and the reason is kept for the refusal.
 */
export async function holderHealth(apiPort) {
  try {
    const response = await fetch(`http://127.0.0.1:${apiPort}/healthz`);
    if (!response.ok) return { weles: false, detail: `it answered /healthz with HTTP ${response.status}` };
    const body = await response.json();
    const source = typeof body?.source === 'string' ? body.source : '';
    if (!source.startsWith('weles')) {
      return { weles: false, detail: `its /healthz names ${source || 'no source'}` };
    }
    return { weles: true, source, version: typeof body?.version === 'string' ? body.version : '' };
  } catch (error) {
    return { weles: false, detail: `/healthz could not be read: ${error.message}` };
  }
}
