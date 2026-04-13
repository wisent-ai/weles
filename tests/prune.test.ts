import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pruneRecordings } from '../src/prune.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'weles-prune-test-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeFile(name: string, size: number) {
  writeFileSync(join(dir, name), Buffer.alloc(size, 'x'));
  // Force distinct mtimes by nudging 1ms apart
}

describe('pruneRecordings', () => {
  it('does nothing under budget', () => {
    writeFile('a.png', 100);
    writeFile('b.png', 100);
    pruneRecordings(dir, 1000);
    expect(readdirSync(dir)).toHaveLength(2);
  });

  it('deletes oldest files first when over budget', () => {
    writeFile('old.png', 500);
    // touch to make it older
    const oldPath = join(dir, 'old.png');
    const past = new Date(Date.now() - 60000);
    require('node:fs').utimesSync(oldPath, past, past);
    writeFile('new.png', 500);
    pruneRecordings(dir, 600);
    expect(existsSync(join(dir, 'new.png'))).toBe(true);
    expect(existsSync(join(dir, 'old.png'))).toBe(false);
  });

  it('removes sidecar files with same stem', () => {
    writeFile('capture.png', 500);
    writeFile('capture.json', 50);
    const past = new Date(Date.now() - 60000);
    require('node:fs').utimesSync(join(dir, 'capture.png'), past, past);
    require('node:fs').utimesSync(join(dir, 'capture.json'), past, past);
    writeFile('keep.png', 100);
    pruneRecordings(dir, 200);
    expect(existsSync(join(dir, 'capture.png'))).toBe(false);
    expect(existsSync(join(dir, 'capture.json'))).toBe(false);
    expect(existsSync(join(dir, 'keep.png'))).toBe(true);
  });

  it('handles empty directory', () => {
    expect(() => pruneRecordings(dir, 100)).not.toThrow();
  });

  it('handles nonexistent directory', () => {
    expect(() => pruneRecordings('/nonexistent/path', 100)).not.toThrow();
  });
});
