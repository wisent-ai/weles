import { mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { EvidenceRetentionError } from './wire.mjs';
import { canonicalJson, digest } from './wire/canonical-json.mjs';
import { atomicBufferWrite, syncDirectory } from './durable-write.mjs';
import {
  MAX_EVIDENCE_FILE_BYTES,
  MAX_EVIDENCE_MANIFEST_BYTES,
  MAX_EVIDENCE_TOTAL_BYTES,
} from './retention/inventory.mjs';
import { createEvidenceManifest } from './retention/manifest.mjs';

export { RECEIPT_SCHEMA } from './retention/manifest.mjs';

export function createEvidenceRetention({
  config,
  recordingsRoot,
  persistTask,
  uploadArtifacts,
  readArtifactIdentity,
}) {
  async function convertEvidenceFailure(task, error) {
    const runRoot = join(recordingsRoot, task.id);
    const failureRoot = join(
      recordingsRoot,
      '.public-task-retention-failures',
      `${task.id}-${Date.now()}`,
    );
    await mkdir(dirname(failureRoot), { recursive: true, mode: 0o700 });
    await rename(runRoot, failureRoot);
    await syncDirectory(dirname(failureRoot));
    const diagnosticRoot = join(runRoot, 'artifacts');
    await mkdir(diagnosticRoot, { recursive: true, mode: 0o700 });
    const code = error instanceof EvidenceRetentionError ? error.code : 'storage-retries-exhausted';
    const diagnostic = {
      schema: 'weles.browser-evidence-retention-failure.v1',
      taskId: task.id,
      outcome: 'failed',
      code,
      message: String(error?.message ?? error),
      limits: {
        manifestBytes: MAX_EVIDENCE_MANIFEST_BYTES,
        inventoryBytes: MAX_EVIDENCE_TOTAL_BYTES,
        fileBytes: MAX_EVIDENCE_FILE_BYTES,
      },
    };
    await atomicBufferWrite(
      join(diagnosticRoot, 'browser_evidence_retention_failure.json'),
      Buffer.from(`${canonicalJson(diagnostic)}\n`, 'utf8'),
    );
    const result = { state: 'failed', executionRunId: task.id };
    task.completion = {
      status: 'failed',
      result,
      resultDigest: digest(canonicalJson(result)),
      error: `browser evidence retention failed: ${code}`,
      capture: task.completion?.capture ?? null,
      completedAt: new Date().toISOString(),
    };
    task.retentionFailure = { code, quarantinedAt: new Date().toISOString() };
    await persistTask(task);
  }

  const { finalize } = createEvidenceManifest({
    config,
    recordingsRoot,
    persistTask,
    uploadArtifacts,
    readArtifactIdentity,
    convertEvidenceFailure,
  });

  async function retainCompletion(task) {
    try {
      return await finalize(task);
    } catch (error) {
      if (error instanceof EvidenceRetentionError && !task.retentionFailure) {
        await convertEvidenceFailure(task, error);
        try {
          return await finalize(task);
        } catch (retryError) {
          error = retryError;
        }
      }
      // The task stays pending with its error visible and is retried on the
      // next sweep: storage that keeps refusing shows as pending, and no
      // attempt count is chosen to turn it into a failure.
      task.evidenceError = `${task.retentionFailure
        ? 'failed evidence receipt retention is pending'
        : 'evidence retention is pending'}: ${error.message}`;
      await persistTask(task);
      return task;
    }
  }

  return Object.freeze({ retainCompletion });
}
