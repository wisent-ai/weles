import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { EVIDENCE_ARTIFACT_LIMIT_BYTES } from './constants.mjs';

/**
 * The two artifacts the browser-evidence policy requires of every run: a
 * final screenshot and the accessibility tree of the page, each written
 * once, fsynced, and refused when empty or oversized.
 */
export async function captureRequiredBrowserEvidence(activeSession) {
  const directory = runRecordingsDir('artifacts');
  mkdirSync(directory, { recursive: true });
  const screenshot = await activeSession.page.screenshot({
    fullPage: false,
    type: 'png',
  });
  const accessibilityTree = await activeSession.page.locator('body').ariaSnapshot();
  const treeBytes = Buffer.from(accessibilityTree, 'utf8');
  for (const [name, bytes] of [
    ['browser_evidence_final.png', screenshot],
    ['browser_evidence_accessibility_tree.txt', treeBytes],
  ]) {
    if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > EVIDENCE_ARTIFACT_LIMIT_BYTES) {
      throw new Error(`required browser-evidence artifact ${name} is empty or exceeds 8 MiB`);
    }
    const descriptor = openSync(join(directory, name), 'wx', 0o600);
    try {
      writeSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
  }
}
