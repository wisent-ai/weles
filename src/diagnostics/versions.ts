// Per-row code-version capture. Records the exact code that ran each
// trajectory so longitudinal analysis can scope by code version and stop
// conflating outcomes produced by two different commits of the same
// trajectory name. Until this writes to result.versions the table is silent
// about which dist produced each row — the Mac mini's pre-00d646b dist was
// silently ignoring FORCE_EMAIL_DOMAIN and we had no way to tell from the row.

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { isAbsolute, join, relative } from 'node:path';

// Worker entry (scripts/worker/run.mjs) is invoked with cwd=weles repo root,
// so process.cwd() is a stable anchor here. We capture it at module load so
// later chdir cannot move the trajectory-resolution base.
const WELES_ROOT = process.cwd();

function safeExec(cmd: string): string | null {
  try {
    return execSync(cmd, { cwd: WELES_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch { return null; }
}

function getUser(): string | null {
  try { return userInfo().username; } catch { return process.env.USER ?? null; }
}

function getDirty(porcelain: string | null): boolean | null {
  if (porcelain === null) return null;
  return porcelain.length > 0;
}

function getShort(commit: string | null): string | null {
  if (commit === null) return null;
  return commit.slice(0, 8);
}

function readPkgVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(WELES_ROOT, 'package.json'), 'utf8'));
    if (typeof pkg.version === 'string') return pkg.version;
    return null;
  } catch { return null; }
}

// Walk a directory and hash every file's (relative path + bytes) into one
// deterministic digest. Sorted by relative path so output is independent of
// filesystem-walk order. Used to fingerprint both dist/ (compiled helpers)
// and scripts/trajectories/ (the .mjs trajectory tree which lives outside
// dist/ and is NOT covered by weles_dist_sha256).
function hashTree(root: string): { digest: string; file_count: number; total_bytes: number } | null {
  try { statSync(root); } catch { return null; }
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile()) files.push(p);
    }
  }
  try { walk(root); } catch { return null; }
  files.sort();
  const h = createHash('sha256');
  let total = 0;
  for (const f of files) {
    h.update(relative(root, f));
    h.update('\0');
    const buf = readFileSync(f);
    h.update(buf);
    h.update('\0');
    total += buf.byteLength;
  }
  return { digest: h.digest('hex'), file_count: files.length, total_bytes: total };
}

const STATIC = (() => {
  const commit = safeExec('git rev-parse HEAD');
  const dirtyOut = safeExec('git status --porcelain');
  const branch = safeExec('git rev-parse --abbrev-ref HEAD');
  const dist = hashTree(join(WELES_ROOT, 'dist'));
  const trajTree = hashTree(join(WELES_ROOT, 'scripts', 'trajectories'));
  return {
    weles_pkg_version: readPkgVersion(),
    weles_commit: commit,
    weles_commit_short: getShort(commit),
    weles_branch: branch,
    weles_dirty: getDirty(dirtyOut),
    // weles_dist_sha256 hashes every file under dist/ — the compiled
    // helpers/imports that a running trajectory pulls in. Two workers on
    // different commits or different dirty trees get different digests
    // regardless of pkg.version. Use this to scope longitudinal queries.
    weles_dist_sha256: dist?.digest ?? null,
    weles_dist_files: dist?.file_count ?? null,
    weles_dist_bytes: dist?.total_bytes ?? null,
    // trajectories_tree_sha256 hashes every file under scripts/trajectories/
    // — the .mjs files weles actually executes. dist/ doesn't cover them
    // because they live outside src/. A change to ANY trajectory or its
    // siblings (steps/, _shared/, helpers) flips this digest.
    trajectories_tree_sha256: trajTree?.digest ?? null,
    trajectories_tree_files: trajTree?.file_count ?? null,
    trajectories_tree_bytes: trajTree?.total_bytes ?? null,
    worker_host: hostname(),
    worker_user: getUser(),
    node_version: process.version,
    worker_started_at: new Date().toISOString(),
  };
})();

export function captureVersions(trajPath: string | null): Record<string, unknown> {
  const out: Record<string, unknown> = { ...STATIC, recorded_at: new Date().toISOString() };
  if (!trajPath) return out;
  const absPath = isAbsolute(trajPath) ? trajPath : join(WELES_ROOT, trajPath);
  out.trajectory_path = trajPath;
  try {
    const buf = readFileSync(absPath);
    out.trajectory_sha256 = createHash('sha256').update(buf).digest('hex');
    out.trajectory_bytes = buf.byteLength;
  } catch { /* sha capture best-effort */ }
  try {
    out.trajectory_mtime = statSync(absPath).mtime.toISOString();
  } catch { /* mtime capture best-effort */ }
  // trajectory_version is the git provenance for THIS specific file: the sha
  // of the last commit that touched it, the short form, and its committed
  // timestamp. Two trajectories with the same name but different last-commit
  // shas are different versions. If the file is uncommitted, version is
  // suffixed '-dirty'.
  const lastCommit = safeExec(`git log -1 --format=%H -- ${JSON.stringify(trajPath)}`);
  if (lastCommit) {
    const dirtyFile = safeExec(`git status --porcelain -- ${JSON.stringify(trajPath)}`);
    const fileDirty = dirtyFile !== null && dirtyFile.length > 0;
    out.trajectory_version = fileDirty ? `${lastCommit.slice(0, 8)}-dirty` : lastCommit.slice(0, 8);
    out.trajectory_last_commit = lastCommit;
    out.trajectory_last_commit_short = lastCommit.slice(0, 8);
    out.trajectory_file_dirty = fileDirty;
    const lastTs = safeExec(`git log -1 --format=%cI -- ${JSON.stringify(trajPath)}`);
    if (lastTs) out.trajectory_last_commit_at = lastTs;
  }
  return out;
}
