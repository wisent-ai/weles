import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { writeJsonFile } from '../../dist/session/wsession-helpers/capture/artifact/json_file.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reports = join(root, 'build/real-tests/instrumentation');
mkdirSync(reports, { recursive: true });
const directory = mkdtempSync(join(reports, 'json-file-'));
const report = {
  source_revision: execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim(),
  command: [process.execPath, ...process.execArgv, ...process.argv],
  files: [],
};
process.once('exit', (code) => {
  report.exit_status = code;
  writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
});

await test('artifact preserves supplementary characters and sparse array positions', () => {
  const path = join(directory, 'unicode-and-array.json');
  const value = { text: 'A 𝄞 Z', sparse: [, 'last'], omitted: undefined };
  writeJsonFile(path, value);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    text: 'A 𝄞 Z',
    sparse: [null, 'last'],
  });
  report.files.push(path);
});

await test('each member toJSON is observed once with its property key', () => {
  const calls = [];
  const path = join(directory, 'member-key.json');
  const value = {
    member: {
      toJSON(key) {
        calls.push(key);
        return { retained: true };
      },
    },
  };
  writeJsonFile(path, value);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    member: { retained: true },
  });
  assert.deepEqual(calls, ['member']);
  report.files.push(path);
});

await test('a circular artifact reports the actual serialization failure', () => {
  const path = join(directory, 'circular.json');
  const value = {};
  value.self = value;
  assert.throws(() => writeJsonFile(path, value), {
    name: 'TypeError',
    message: 'Converting circular structure to JSON',
  });
  report.files.push(path);
});
console.log(`instrumentation report: ${join(directory, 'report.json')}`);
