// What a run leaves behind, and when two identical requests are one run.
//
// A run outlives the request that asked for it. Its outcome is therefore
// written to a file named by run id, atomically and owner-only, before the
// child is even spawned and again when it settles -- that document is what a
// caller who lost its socket reads afterwards, and what the diagnostics route
// serves. Beside it sit the readers of what the run itself produced: the last
// JSON line the trajectory printed, the result document a generic browser task
// writes into its recording directory, and the named documents every
// trajectory leaves in its recording tree (Pangram verdict, ban signal, task
// result, pending review, ...), keyed the way run callers read them.
//
// Coalescing belongs to the same subject because it decides how many outcomes
// exist. A browser login costs a real sign-in on a real account, so two callers
// asking for the same one within the deduplication window join a single run and
// read a single outcome instead of burning the account twice.

import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, realpathSync, writeFileSync } from 'node:fs';
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

// Which recording file a caller reads under which key. The table is the one the
// database-polled worker assembled into each run's result before it was removed;
// echo-web's job pages, the Pangram check and the logs route still read it.
const RUN_OUTPUT_FILES = Object.freeze({
  'pangram_result.json': 'pangram',
  'generic_task_result.json': 'generic_browser_task',
  'ban_signal.json': 'ban_signal',
  'pending_review.json': 'pending_review',
  'service_action_result.json': 'service_action',
  'capture_result.json': 'capture',
  'accessibility_audit_result.json': 'accessibility_audit',
  'captcha_events.json': 'captcha',
  'overleaf_version_history_summary.json': 'overleaf_version_history_summary',
  'yahoo_register_result.json': 'yahoo_register',
});
const RUN_OUTPUT_DEPTH = 3;
const RUN_OUTPUT_MAX_BYTES = 1024 * 1024;

// The named documents under recordings/<run>/, read without following a link
// out of the run's tree. A file that does not parse is reported by name under
// output_errors rather than dropped, so a reader can tell unreadable from absent.
export function runOutputs(runId) {
  const outputs = {};
  const errors = {};
  const runRoot = join(RECORDINGS_ROOT, runId);
  let rootMetadata;
  try { rootMetadata = lstatSync(runRoot); } catch { return { outputs, errors }; }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    errors['.'] = 'recording root is a symbolic link or not a directory';
    return { outputs, errors };
  }
  let realRunRoot;
  try {
    realRunRoot = realpathSync(runRoot);
    if (!realRunRoot.startsWith(`${realpathSync(RECORDINGS_ROOT)}${sep}`)) throw new Error('recording root resolves outside the recordings directory');
  } catch (error) {
    errors['.'] = String(error?.message || error).slice(0, 240);
    return { outputs, errors };
  }
  const visit = (directory, depth) => {
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }); } catch (error) {
      errors[directory.slice(realRunRoot.length + 1) || '.'] = String(error?.message || error).slice(0, 240);
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && depth < RUN_OUTPUT_DEPTH) { visit(path, depth + 1); continue; }
      const key = RUN_OUTPUT_FILES[entry.name];
      if (!entry.isFile() || !key || key in outputs) continue;
      try {
        const size = lstatSync(path).size;
        if (size > RUN_OUTPUT_MAX_BYTES) throw new Error(`${size} bytes exceeds ${RUN_OUTPUT_MAX_BYTES}`);
        outputs[key] = JSON.parse(readFileSync(path, 'utf8'));
      } catch (error) {
        errors[path.slice(realRunRoot.length + 1)] = String(error?.message || error).slice(0, 240);
      }
    }
  };
  visit(realRunRoot, 0);
  return { outputs, errors };
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
