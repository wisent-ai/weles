/**
 * Recording directory auto-pruning.
 *
 * Walks a directory recursively and removes oldest files (by mtime) until
 * total size drops below the byte budget. Sidecar files that share the same
 * stem as a deleted file are removed alongside their parent.
 */

import { readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';

const SIDECAR_EXTS = ['.json', '.txt', '.log', '.png', '.webm', '.har', '.html'];

interface FileEntry {
  mtime: number;
  size: number;
  path: string;
}

function walk(dir: string): FileEntry[] {
  const result: FileEntry[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...walk(full));
      } else {
        try {
          const st = statSync(full);
          result.push({ mtime: st.mtimeMs, size: st.size, path: full });
        } catch { /* skip unreadable */ }
      }
    }
  } catch { /* skip unreadable dirs */ }
  return result;
}

export function pruneRecordings(dir: string, maxBytes: number): void {
  try {
    const files = walk(dir);
    files.sort((a, b) => a.mtime - b.mtime); // oldest first
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= maxBytes) return;

    for (const { size, path: fp } of files) {
      if (total <= maxBytes) break;
      try {
        unlinkSync(fp);
        total -= size;
      } catch { continue; }
      // Remove sidecar files with same stem
      const stem = fp.slice(0, fp.length - extname(fp).length);
      for (const ext of SIDECAR_EXTS) {
        const sc = stem + ext;
        if (sc === fp) continue;
        try {
          const scSize = statSync(sc).size;
          unlinkSync(sc);
          total -= scSize;
        } catch { /* skip */ }
      }
    }
  } catch { /* skip all errors */ }
}
