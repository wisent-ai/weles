#!/usr/bin/env node
/**
 * Guardrail: every plain JavaScript module Weles runs without a build step
 * (trajectories, keeper clients, operator requests) must parse. A trajectory
 * that does not parse fails only when somebody runs it, on a worker, after
 * the commit that broke it has shipped; this check fails at the commit.
 *
 * Arguments narrow the scan to files or directories; without them it scans
 * src/ and tests/. Each file is checked with `node --check`, and every file
 * that does not parse is listed with Node's own message.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
const targets = process.argv.slice(2).map((p) => resolve(p));
const scanRoots = targets.length ? targets : [join(ROOT, 'src'), join(ROOT, 'tests')];

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'recordings', '.work', 'coverage']);
const EXTENSIONS = ['.mjs', '.cjs', '.js'];

function walk(path, out = []) {
  const st = statSync(path);
  if (st.isDirectory()) {
    if (SKIP_DIRS.has(path.split('/').pop())) return out;
    for (const entry of readdirSync(path)) walk(join(path, entry), out);
  } else if (st.isFile() && EXTENSIONS.some((ext) => path.endsWith(ext))) {
    out.push(path);
  }
  return out;
}

const files = scanRoots.flatMap((p) => walk(p)).sort();
const failures = [];
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) failures.push({ file: relative(ROOT, file), detail: String(result.stderr || result.stdout).trim() });
}

if (!failures.length) {
  console.log(`[lint-module-syntax] OK — ${files.length} modules parse`);
  process.exit(0);
}
console.log(`[lint-module-syntax] FAIL — ${failures.length} of ${files.length} modules do not parse:\n`);
for (const failure of failures) console.log(`${failure.file}\n${failure.detail}\n`);
process.exit(1);
