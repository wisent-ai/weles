// Per-run recordings layout. Every artifact a run produces lives under
//   recordings/<run_uuid>/<action>/...
// where run_uuid = the account_action_logs row id (the worker passes it as
// ACTION_LOG_ID). This makes recording↔run attribution exact (matches the
// Supabase row 1:1), survives label≠action mismatches, and is concurrency-safe:
// two runs of the same action never share a directory.
//
// A single run executes a trajectory that performs many actions/steps (and some
// trajectories chain multiple actions, e.g. register_then_comment), so the
// <action> segment under <run_uuid> separates those — it is NOT redundant.
//
// uploadArtifacts mirrors the whole recordings/<run_uuid>/ tree to storage at
// <run_uuid>/<...>, so anything written under the run's folder is uploaded
// regardless of which sub-action/label dir it landed in.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

// The run identifier. ACTION_LOG_ID is set by the worker (poll.ts) for every
// dispatched trajectory. Standalone/manual runs fall back to 'local' (they are
// dev-only and not uploaded by the worker).
export function runId(): string {
  return process.env.ACTION_LOG_ID || process.env.WELES_RUN_ID || 'local';
}

// recordings/<run_uuid>/ — the root for everything this run produces.
export function runRecordingsRoot(): string {
  const d = join(recordingsBase(), runId());
  mkdirSync(d, { recursive: true });
  return d;
}

// Where recordings live. Default: <cwd>/recordings (the worker runs from the
// repo root). WELES_RECORDINGS_ROOT relocates the whole store — e.g. onto a
// larger data volume. The host service environment owns this deployment
// setting; the worker does not read a fleet registry.
function recordingsBase(): string {
  return process.env.WELES_RECORDINGS_ROOT || join(process.cwd(), 'recordings');
}

// recordings/<run_uuid>/<...segments>/ (mkdir -p). Callers pass the action
// (and any deeper sub-path); the run_uuid prefix is added here. Pass no
// segment to get the run root. Defaults the first segment to the dispatch
// ACTION when called with none and ACTION is set.
export function runRecordingsDir(...segments: string[]): string {
  const segs = segments.length === 0 && process.env.ACTION ? [process.env.ACTION] : segments;
  const d = join(recordingsBase(), runId(), ...segs);
  mkdirSync(d, { recursive: true });
  return d;
}
