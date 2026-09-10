// What a run leaves behind, and when two identical requests are one run.
//
// A run outlives the request that asked for it. Its outcome is therefore
// written to a file named by run id, atomically and owner-only, before the
// child is even spawned and again when it settles -- that document is what a
// caller who lost its socket reads afterwards, and what the diagnostics route
// serves. Beside it sit the two readers of what the run itself produced: the
// last JSON line the trajectory printed, and the result document a generic
// browser task writes into its recording directory.
//
// Coalescing belongs to the same subject because it decides how many outcomes
// exist. A browser login costs a real sign-in on a real account, so two callers
// asking for the same one within the deduplication window join a single run and
// read a single outcome instead of burning the account twice.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, statSync, realpathSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';

import { RECORDINGS_ROOT, RUN_DEDUPLICATION_TTL_MS, RUN_RESULTS_DIR } from '../configuration.mjs';

export const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function persistRunResult(path, document) {
  mkdirSync(RUN_RESULTS_DIR, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(document), { mode: 0o600 });
  renameSync(temporary, path);
}

export function runResultFile(runId) {
  const candidate = join(RUN_RESULTS_DIR, `${runId}.json`);
  try {
    const resultsRoot = realpathSync(RUN_RESULTS_DIR);
    const lstat = lstatSync(candidate);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
    const path = realpathSync(candidate);
    if (!path.startsWith(`${resultsRoot}${sep}`)) return null;
    return { path, stat: statSync(path) };
  } catch {
    return null;
  }
}

export function lastJsonLine(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i].startsWith('{') || lines[i].startsWith('[')) {
      try { return JSON.parse(lines[i]); } catch { /* keep scanning up */ }
    }
  }
  return null;
}

export function findResultDoc(runId) {
  const runRoot = join(RECORDINGS_ROOT, runId);
  const actionRoot = join(runRoot, 'generic_browser_task');
  const resultPath = join(actionRoot, 'generic_task_result.json');
  try {
    const runMetadata = lstatSync(runRoot);
    const actionMetadata = lstatSync(actionRoot);
    const resultMetadata = lstatSync(resultPath);
    if (!runMetadata.isDirectory() || runMetadata.isSymbolicLink()
        || !actionMetadata.isDirectory() || actionMetadata.isSymbolicLink()
        || !resultMetadata.isFile() || resultMetadata.isSymbolicLink()
        || resultMetadata.size < 1 || resultMetadata.size > 1024 * 1024) {
      return null;
    }
    const realRunRoot = realpathSync(runRoot);
    const realResult = realpathSync(resultPath);
    if (!realResult.startsWith(`${realRunRoot}${sep}`)) return null;
    return JSON.parse(readFileSync(resultPath, 'utf8'));
  } catch {
    return null;
  }
}

const coalescedRuns = new Map();

export function runAdmissionKey(kind, identity) {
  return `${kind}:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`;
}

export function coalesceRun(key, start, metadata = {}) {
  const now = Date.now();
  const existing = coalescedRuns.get(key);
  if (existing && (existing.completedAt === null || now - existing.completedAt <= RUN_DEDUPLICATION_TTL_MS)) {
    return { entry: existing, joined: true };
  }
  const entry = { promise: null, completedAt: null, metadata };
  entry.promise = Promise.resolve()
    .then(start)
    .finally(() => {
      entry.completedAt = Date.now();
      const timer = setTimeout(() => {
        if (coalescedRuns.get(key) === entry) coalescedRuns.delete(key);
      }, RUN_DEDUPLICATION_TTL_MS);
      timer.unref();
    });
  coalescedRuns.set(key, entry);
  return { entry, joined: false };
}
