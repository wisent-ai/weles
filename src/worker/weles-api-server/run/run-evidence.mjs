// Where a run's artifacts are, which of them a caller may open, and what each
// one is.
//
// A run's evidence does not live in one place. The recordings root moved out of
// the runtime tree so that activating a new release cannot strand the previous
// release's screenshots, and two earlier installer layouts still hold runs that
// Stado's activity reader counts and therefore reports to operators. All of
// them are searched, in that order, so a run that happened remains diagnosable
// after the release that produced it is gone.
//
// Every path a caller supplies is resolved against the run's own root and
// rejected if it leaves it, symbolic links are refused rather than followed,
// and the media type is decided from the extension here so the download route
// never has to guess. That is one subject: what may be handed out, and as what.

import { readdirSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';

import { REPO } from '../release-identity.mjs';
import { SAFE_RUN_ID, runResultFile } from './run-outcome.mjs';

export function diagnosticsContentType(path) {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.webm': return 'video/webm';
    case '.mp4': return 'video/mp4';
    case '.html': return 'text/html; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.ndjson': return 'application/x-ndjson; charset=utf-8';
    case '.har': return 'application/json; charset=utf-8';
    case '.log':
    case '.txt':
    case '.patch': return 'text/plain; charset=utf-8';
    case '.pcap': return 'application/vnd.tcpdump.pcap';
    default: return 'application/octet-stream';
  }
}

export function decodeRunId(raw) {
  try {
    const runId = decodeURIComponent(raw);
    return SAFE_RUN_ID.test(runId) ? runId : null;
  } catch {
    return null;
  }
}

function diagnosticsCandidates() {
  const candidates = [];
  const seen = new Set();
  const add = (candidate) => {
    if (!candidate || seen.has(candidate)) return;
    seen.add(candidate);
    candidates.push(candidate);
  };

  // New releases write outside their immutable runtime so an activation cannot
  // strand the previous release's evidence.
  add(process.env.WELES_RECORDINGS_ROOT);
  add(join(REPO, 'recordings'));

  // Managed releases before the stable recordings root wrote beside their
  // unpacked runtime. Keep those runs diagnosable after `current` advances.
  const managed = join(homedir(), '.stado', 'services', 'weles-admission');
  try {
    for (const release of readdirSync(managed, { withFileTypes: true })) {
      if (!release.isDirectory()) continue;
      const releaseRoot = join(managed, release.name);
      for (const platform of readdirSync(releaseRoot, { withFileTypes: true })) {
        if (!platform.isDirectory()) continue;
        add(join(releaseRoot, platform.name, 'runtime', 'recordings'));
      }
    }
  } catch {}

  // The retired per-version installer is still where runs made by 0.5.44 and
  // earlier live. Stado's activity reader already counts these exact roots; the
  // authenticated diagnostics route must be able to open the run it reports.
  const legacy = join(homedir(), '.local', 'share', 'weles-worker');
  try {
    for (const release of readdirSync(legacy, { withFileTypes: true })) {
      if (!release.isDirectory()) continue;
      const releaseRoot = join(legacy, release.name);
      for (const platform of readdirSync(releaseRoot, { withFileTypes: true })) {
        if (!platform.isDirectory()) continue;
        add(join(releaseRoot, platform.name, 'recordings'));
      }
    }
  } catch {}
  return candidates;
}

function diagnosticsRoot(runId) {
  for (const candidate of diagnosticsCandidates()) {
    let recordingsRoot;
    let runRoot;
    try {
      recordingsRoot = realpathSync(candidate);
      runRoot = realpathSync(join(recordingsRoot, runId));
    } catch {
      continue;
    }
    if (runRoot.startsWith(`${recordingsRoot}${sep}`)) return runRoot;
  }
  return null;
}

export function diagnosticsManifest(runId) {
  const root = diagnosticsRoot(runId);
  const result = runResultFile(runId);
  if (!root && !result) return null;
  const files = [];
  if (result) {
    files.push({
      path: 'run-result.json',
      bytes: result.stat.size,
      modified_at: result.stat.mtime.toISOString(),
      content_type: 'application/json',
      download_url: `/diagnostics/${encodeURIComponent(runId)}/file?path=run-result.json`,
    });
  }
  const stack = root ? [{ dir: root, rel: '' }] : [];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try { entries = readdirSync(current.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(current.dir, entry.name);
      const rel = current.rel ? `${current.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push({ dir: full, rel });
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try { stat = statSync(full); } catch { continue; }
      files.push({
        path: rel,
        bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        content_type: diagnosticsContentType(rel),
        download_url: `/diagnostics/${encodeURIComponent(runId)}/file?path=${encodeURIComponent(rel)}`,
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    ok: true,
    run_id: runId,
    recordings_root: root,
    total_files: files.length,
    total_bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files,
  };
}

export function diagnosticFile(runId, requestedPath) {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0 || requestedPath.includes('\0')) return null;
  if (requestedPath === 'run-result.json') return runResultFile(runId);
  const root = diagnosticsRoot(runId);
  if (!root) return null;
  const candidate = resolve(root, requestedPath);
  if (!candidate.startsWith(`${root}${sep}`)) return null;
  try {
    const lstat = lstatSync(candidate);
    if (lstat.isSymbolicLink() || !lstat.isFile()) return null;
    const real = realpathSync(candidate);
    if (!real.startsWith(`${root}${sep}`)) return null;
    const stat = statSync(real);
    return { path: real, stat };
  } catch {
    return null;
  }
}
