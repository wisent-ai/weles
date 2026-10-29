import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserContext, ConsoleMessage } from 'playwright';

import { runRecordingsDir } from '../session/run-recordings.js';

/**
 * The console marker a page-init patch writes when it cannot install itself
 * (page/screen_webrtc_patch.js, page/navigator/webrtc.js and
 * page/navigator/environment.js), followed by a JSON object naming the patch
 * and the error. A patch that fails leaves the browser's own behaviour in
 * place, so a failure is never only the page's business: the patch says it on
 * the console, where Weles reads it, without a global the page could see.
 */
export const PAGE_INIT_FAILURE = '__weles_page_init_failure__';

/**
 * The patches whose failure exposes the machine behind the proxy, so the page
 * that reported it is closed: native WebRTC hands every site the host and
 * server-reflexive candidate addresses the shim exists to strip.
 */
const EXPOSING_PATCHES: Readonly<Record<string, string>> = {
  webrtc:
    'native WebRTC would hand the site the host and public addresses behind the proxy',
};

/**
 * The patch a failure report names, read from the JSON the page wrote after
 * the marker; a report that cannot be read is answered with why, since any
 * script on the page can write the marker.
 */
function reportedPatch(reported: string): string | Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reported);
  } catch (error) {
    return new Error(
      `its report is not JSON (${error instanceof Error ? error.message : String(error)}), so which patch failed is unknown`,
    );
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('patch' in parsed) ||
    typeof parsed.patch !== 'string'
  ) {
    return new Error(
      'its report names no patch, so which patch failed is unknown',
    );
  }
  return parsed.patch;
}

/**
 * Closes the page that reported an exposing patch failure, so it stops running
 * with the browser's own behaviour; a trajectory using it then fails on the
 * closed page, and the ledger says why.
 */
async function closeExposedPage(
  message: ConsoleMessage,
  why: string,
): Promise<string> {
  const page = message.page();
  if (!page) return `no page to close (${why})`;
  await page.close();
  return `page closed: ${why}`;
}

/**
 * Keep every page-init failure `context`'s pages report, one JSON line each,
 * in `page-init-failures.jsonl` of the session's recordings directory
 * (recordings/<run>/<label>/, or the run's own directory for an unlabelled
 * session), say it on Weles's log, and close a page whose failure exposes the
 * host, so a run whose privacy patch did not take is never read as one that
 * hid the host.
 */
export function watchPageInitFailures(context: BrowserContext): void {
  const label = process.env.WELES_LABEL;
  const directory = label ? runRecordingsDir(label) : runRecordingsDir();
  const ledger = join(directory, 'page-init-failures.jsonl');
  const keep = (entry: Record<string, unknown>) => {
    mkdirSync(directory, { recursive: true });
    appendFileSync(ledger, `${JSON.stringify(entry)}\n`);
  };
  context.on('console', (message) => {
    const text = message.text();
    if (!text.startsWith(PAGE_INIT_FAILURE)) return;
    const reported = text.slice(PAGE_INIT_FAILURE.length).trim();
    const url = message.page()?.url();
    const at = new Date().toISOString();
    console.log(`[page-init] patch failed on ${url}: ${reported}`);
    const patch = reportedPatch(reported);
    if (typeof patch === 'string' && !Object.hasOwn(EXPOSING_PATCHES, patch)) {
      keep({ at, url, reported });
      return;
    }
    const why =
      typeof patch === 'string' ? EXPOSING_PATCHES[patch] : patch.message;
    closeExposedPage(message, why).then(
      (action) => {
        console.log(`[page-init] ${action} (${url})`);
        keep({ at, url, reported, action });
      },
      (error: unknown) => {
        const action = `the page could not be closed: ${error instanceof Error ? error.message : String(error)}`;
        console.error(`[page-init] ${action} (${url})`);
        keep({ at, url, reported, action });
      },
    );
  });
}
