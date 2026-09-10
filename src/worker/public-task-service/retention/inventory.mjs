import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { EvidenceRetentionError } from '../wire.mjs';
import { isObject } from '../wire/canonical-json.mjs';

const EVIDENCE_PATH_COMPONENT_RE = /^[A-Za-z0-9._-]+$/;
const MAX_EVIDENCE_FILES = 10_000;
export const MAX_EVIDENCE_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_TOTAL_BYTES = 8 * 1024 * 1024;
export const MAX_EVIDENCE_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_WITHHELD_EDGE_BYTES = 2 * 1024 * 1024;
const MAX_WITHHELD_EDGES = 2_048;
export const RECEIPT_MANIFEST_NAME = 'evidence-manifest.json';
const WITHHELD_EDGES_NAME = 'browser_evidence_withheld_edges.ndjson';

function stableMetadata(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function hashStableFile(path) {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new EvidenceRetentionError('evidence-file-unsafe', `evidence path is not a regular file: ${path}`);
  if (before.size > MAX_EVIDENCE_FILE_BYTES) {
    throw new EvidenceRetentionError('evidence-file-too-large', `evidence file exceeds the per-file limit: ${path}`);
  }
  const hasher = createHash('sha256');
  await new Promise((resolveHash, rejectHash) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hasher.update(chunk));
    stream.once('error', rejectHash);
    stream.once('end', resolveHash);
  });
  const after = await lstat(path);
  if (!stableMetadata(before, after)) throw new EvidenceRetentionError('evidence-file-unstable', `evidence file changed while hashing: ${path}`);
  return { bytes: after.size, sha256: hasher.digest('hex'), metadata: after };
}

export async function collectEvidenceFiles(root) {
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new EvidenceRetentionError('evidence-root-unsafe', 'evidence root is not a regular directory');
  const files = [];
  const stack = [{ directory: root, relative: '' }];
  let totalBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = await readdir(current.directory, { withFileTypes: true });
    for (const entry of entries) {
      if (!EVIDENCE_PATH_COMPONENT_RE.test(entry.name)) {
        throw new EvidenceRetentionError(
          'evidence-path-unsafe',
          `evidence path component is not portable: ${entry.name}`,
        );
      }
      if (entry.isSymbolicLink()) throw new EvidenceRetentionError('evidence-symlink', `symlink is forbidden in evidence: ${entry.name}`);
      const fullPath = join(current.directory, entry.name);
      const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        stack.push({ directory: fullPath, relative: relativePath });
        continue;
      }
      if (!entry.isFile()) throw new EvidenceRetentionError('evidence-entry-unsafe', `non-regular evidence entry is forbidden: ${relativePath}`);
      if (entry.name === RECEIPT_MANIFEST_NAME || entry.name === '.uploaded.json') continue;
      if (files.length >= MAX_EVIDENCE_FILES) {
        throw new EvidenceRetentionError('evidence-file-count-exceeded', 'evidence file count exceeds the limit');
      }
      const hashed = await hashStableFile(fullPath);
      if (hashed.bytes < 1) {
        // The Spis bridge requires a positive byte count on every inventory
        // entry, so an empty retained file would make the signed receipt
        // permanently unverifiable. Fail retention instead of signing it.
        throw new EvidenceRetentionError(
          'evidence-file-empty',
          `retained evidence file is empty: ${relativePath}`,
        );
      }
      totalBytes += hashed.bytes;
      if (totalBytes > MAX_EVIDENCE_TOTAL_BYTES) {
        throw new EvidenceRetentionError('evidence-total-too-large', 'evidence bytes exceed the total limit');
      }
      files.push({
        path: relativePath,
        bytes: hashed.bytes,
        sha256: hashed.sha256,
        fullPath,
        metadata: hashed.metadata,
      });
    }
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}


export async function retainedWithheldEdges(files) {
  const edges = [];
  let bytes = 0;
  for (const file of files.filter((candidate) => basename(candidate.path) === WITHHELD_EDGES_NAME)) {
    bytes += file.bytes;
    if (bytes > MAX_WITHHELD_EDGE_BYTES) throw new EvidenceRetentionError('withheld-edge-bytes-exceeded', 'withheld-edge evidence exceeds the byte limit');
    const lines = (await readFile(file.fullPath, 'utf8')).split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      if (edges.length >= MAX_WITHHELD_EDGES) throw new EvidenceRetentionError('withheld-edge-count-exceeded', 'withheld-edge evidence exceeds the edge limit');
      try {
        const edge = JSON.parse(line);
        if (!isObject(edge)) throw new Error('edge is not an object');
        edges.push(edge);
      } catch {
        throw new EvidenceRetentionError('withheld-edge-malformed', `withheld-edge evidence is not valid NDJSON: ${file.path}`);
      }
    }
  }
  return edges;
}

// The Spis bridge binds each reserved kind to one exact recording URI:
// `screenshot` must be `artifacts/browser_evidence_final.png` and
// `accessibility_tree` must be `artifacts/browser_evidence_accessibility_tree.txt`.
// Keying these off the basename would label a same-named file in any other
// directory as the reserved kind and sign an inventory the bridge is certain to
// reject, so the reserved kinds match the exact retained relative path and every
// other file stays an `artifact:{relative-path}` entry.
const RESERVED_EVIDENCE_KINDS = new Map([
  ['artifacts/browser_evidence_final.png', 'screenshot'],
  ['artifacts/browser_evidence_accessibility_tree.txt', 'accessibility_tree'],
]);

function publicEvidenceKind(path) {
  return RESERVED_EVIDENCE_KINDS.get(path) ?? `artifact:${path}`;
}

export function publicEvidenceInventory(files, taskId) {
  return files.map((file) => ({
    kind: publicEvidenceKind(file.path),
    uri: `stado://weles/recordings/${taskId}/${file.path}`,
    sha256: file.sha256,
    bytes: file.bytes,
  }));
}
