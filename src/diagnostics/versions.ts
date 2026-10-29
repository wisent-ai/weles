// Per-row code-version capture: the exact code and machine that ran each
// trajectory, so outcomes can be scoped by code version instead of conflating
// two commits of the same trajectory name. A value that could not be read is
// absent from the row and named, with its cause, in version_capture_failures.

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  WELES_ROOT,
  captureFailure,
  captureFailures,
  safeExec,
  type CaptureFailure,
} from './versions/failures.js';
import { machineIdentity, machinePublicAddress } from './versions/machine.js';
import {
  hashTree,
  hashWorkerEntry,
  type TreeDigest,
} from './versions/tree-hash.js';

function readPkgVersion(): string | undefined {
  const path = join(WELES_ROOT, 'package.json');
  let version: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    if (typeof pkg.version !== 'string')
      throw new Error('package.json has no string version');
    version = pkg.version;
  } catch (error) {
    captureFailures.push(
      captureFailure('weles_pkg_version', `read ${path}`, error),
    );
  }
  return version;
}

/** A digest's three fields under the row's names for them; none when it was not read. */
function digestFields(
  prefix: string,
  digestName: string,
  digest: TreeDigest | undefined,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  if (!digest) return fields;
  fields[`${prefix}_${digestName}`] = digest.digest;
  fields[`${prefix}_files`] = digest.file_count;
  fields[`${prefix}_bytes`] = digest.total_bytes;
  return fields;
}

/** The commit fields of a `git log --format=%H%n%h[%n%cI]` answer, by line. */
function commitLines(output: string | undefined): {
  full?: string;
  short?: string;
  at?: string;
} {
  if (!output) return {};
  const [full, short, at] = output.split('\n');
  return { full, short, at };
}

const STATIC = (() => {
  const head = commitLines(
    safeExec('git log -1 --format=%H%n%h', 'weles_commit'),
  );
  const porcelain = safeExec('git status --porcelain', 'weles_dirty');
  const machine = machineIdentity();
  return {
    weles_pkg_version: readPkgVersion(),
    weles_commit: head.full,
    weles_commit_short: head.short,
    weles_branch: safeExec('git rev-parse --abbrev-ref HEAD', 'weles_branch'),
    weles_dirty: porcelain === undefined ? undefined : Boolean(porcelain),
    // Every file under dist/: the compiled helpers a running trajectory
    // imports. Two workers on different commits or dirty trees differ here
    // whatever package.json's version says.
    ...digestFields(
      'weles_dist',
      'sha256',
      hashTree(join(WELES_ROOT, 'dist'), 'weles_dist_sha256'),
    ),
    // Every file under src/trajectories/: the .mjs files Weles executes,
    // which dist/ does not hold.
    ...digestFields(
      'trajectories_tree',
      'sha256',
      hashTree(
        join(WELES_ROOT, 'src', 'trajectories'),
        'trajectories_tree_sha256',
      ),
    ),
    // The worker launchers under src/worker/, the process entry itself.
    ...digestFields('runner_entry', 'sha256', hashWorkerEntry()),
    worker_host: machine.hostname,
    worker_user: machine.user,
    node_version: process.version,
    worker_started_at: new Date().toISOString(),
    machine,
  };
})();

/** The trajectory file's own provenance: its bytes, mtime and last commit. */
function trajectoryFields(
  trajPath: string,
  failures: CaptureFailure[],
): Record<string, unknown> {
  const absPath = isAbsolute(trajPath) ? trajPath : join(WELES_ROOT, trajPath);
  const out: Record<string, unknown> = { trajectory_path: trajPath };
  try {
    const bytes = readFileSync(absPath);
    out.trajectory_sha256 = createHash('sha256').update(bytes).digest('hex');
    out.trajectory_bytes = bytes.byteLength;
  } catch (error) {
    failures.push(
      captureFailure('trajectory_sha256', `read ${absPath}`, error),
    );
  }
  try {
    out.trajectory_mtime = statSync(absPath).mtime.toISOString();
  } catch (error) {
    failures.push(captureFailure('trajectory_mtime', `stat ${absPath}`, error));
  }
  // The last commit that touched this file is its version; an uncommitted
  // change to it marks the version dirty.
  const quoted = JSON.stringify(trajPath);
  const last = commitLines(
    safeExec(
      `git log -1 --format=%H%n%h%n%cI -- ${quoted}`,
      'trajectory_last_commit',
      failures,
    ),
  );
  if (!last.full) return out;
  out.trajectory_last_commit = last.full;
  out.trajectory_last_commit_short = last.short;
  out.trajectory_last_commit_at = last.at;
  const porcelain = safeExec(
    `git status --porcelain -- ${quoted}`,
    'trajectory_file_dirty',
    failures,
  );
  if (porcelain === undefined) return out;
  const dirty = Boolean(porcelain);
  out.trajectory_file_dirty = dirty;
  out.trajectory_version = dirty ? `${last.short}-dirty` : last.short;
  return out;
}

export function captureVersions(
  trajPath: string | null,
): Record<string, unknown> {
  const failures = [...captureFailures];
  const out: Record<string, unknown> = {
    ...STATIC,
    // A fresh machine object: the public address resolves after load, and
    // the shared STATIC.machine is never mutated.
    machine: { ...STATIC.machine, public_ip: machinePublicAddress() },
    version_capture_failures: failures,
    recorded_at: new Date().toISOString(),
  };
  if (trajPath) Object.assign(out, trajectoryFields(trajPath, failures));
  // A dirty repository or trajectory keeps the full working-tree diff, so the
  // uncommitted source that produced the row is recoverable from the row.
  // poll.ts mirrors it to recordings/<action>/source_diff.patch.
  if (out.weles_dirty === true || out.trajectory_file_dirty === true) {
    const diff = safeExec('git diff', 'dirty_diff', failures);
    if (diff) out.dirty_diff = diff;
  }
  return out;
}
