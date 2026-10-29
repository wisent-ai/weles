// The run's HAR (session.har) is recorded by Playwright in full mode, which
// keeps every request body as sent, including a form that posts a typed
// password. Weles reads only responses out of it; the request bodies a run
// needs to diagnose are kept by the network capture, with masked field
// values removed. So once the context has closed and Playwright has sealed
// the HAR, every request body is taken out of it, and a HAR that cannot be
// rewritten is removed rather than left in the recordings with its bodies.

import {
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../run-recordings.js';

/** The file chromium.ts records the HAR into, beside the run's other recordings. */
const HAR_FILE = 'session.har';
const WITHHELD =
  '[request body withheld from the HAR: the network capture keeps it with masked fields removed]';

/** Where the run labelled `label` records its HAR. */
export function harPath(label: string): string {
  return join(runRecordingsDir(label), HAR_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The HAR's entries, or why the document holds none. */
function entriesOf(har: unknown): unknown[] {
  if (!isRecord(har) || !isRecord(har.log) || !Array.isArray(har.log.entries)) {
    throw new Error('it holds no log.entries array');
  }
  return har.log.entries;
}

/** Every request body in the HAR at `path` replaced by a withheld note. */
export function scrubHar(path: string): void {
  if (!existsSync(path)) return;
  try {
    const har: unknown = JSON.parse(readFileSync(path, 'utf8'));
    for (const entry of entriesOf(har)) {
      if (!isRecord(entry) || !isRecord(entry.request)) continue;
      const sent = entry.request.postData;
      if (sent === undefined) continue;
      entry.request.postData = {
        mimeType: isRecord(sent) ? sent.mimeType : undefined,
        text: WITHHELD,
      };
    }
    const scratch = `${path}.scrubbing`;
    writeFileSync(scratch, JSON.stringify(har));
    renameSync(scratch, path);
  } catch (error) {
    rmSync(path, { force: true });
    console.log(
      `[wsession] ${path} removed: its request bodies could not be withheld, and a body may carry a typed password: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
