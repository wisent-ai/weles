#!/usr/bin/env node
/**
 * Prepare a managed Weles runtime: a git checkout a host serves the API from.
 *
 * A published release is a built archive carrying two things the source tree
 * does not: `release/source-identity.json`, which says which commit and
 * version the process may claim, and `native/jeden/bin`, the runtime the
 * launcher refuses to start without. `stado workload run weles-api-runtime`
 * maintains a plain checkout instead — fetch, checkout, npm ci, npm run build
 * — so it produced a tree that can never start. charless-mac-mini sat in a
 * launchd restart loop printing `required Weles native runtime is
 * unavailable` while every report called the unit restarted.
 *
 * This command is the missing step, and it belongs to Weles because it is
 * Weles that decides what a servable tree contains.
 *
 * Usage: node release/native/managed.mjs prepare
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const IDENTITY_FILE = join(ROOT, 'release', 'source-identity.json');
const NATIVE_BIN = join(ROOT, 'native', 'jeden', 'bin');
const IDENTITY_SCHEMA = 'weles.source-identity.v1';
const PRODUCT = 'weles-worker';
/** A managed tree is a git checkout, so its identity is the commit it is on. */
const IDENTITY_KIND = 'git-commit';
const REVISION_PATTERN = /^[0-9a-f]{40}$/;

function git(args) {
  const result = spawnSync('git', ['-C', ROOT, ...args], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || result.error?.message || '').trim()}`);
  }
  return result.stdout.trim();
}

function node(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`${args.join(' ')} failed (exit ${result.status ?? 'none'}): ${result.error?.message || 'see output above'}`);
  }
}

function prepare() {
  const revision = git(['rev-parse', 'HEAD']);
  if (!REVISION_PATTERN.test(revision)) {
    throw new Error(`the checkout is not on a full commit: ${revision}`);
  }
  const dirty = git(['status', '--porcelain', '--untracked-files=no']);
  if (dirty) {
    throw new Error(`a managed runtime must serve an exact commit; this tree is modified:\n${dirty}`);
  }
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const identity = {
    schema: IDENTITY_SCHEMA,
    product: PRODUCT,
    version,
    source_revision: revision,
    source_identity_kind: IDENTITY_KIND,
  };
  writeFileSync(IDENTITY_FILE, `${JSON.stringify(identity)}\n`);
  node([join(ROOT, 'release', 'native', 'runtime.mjs'), 'install', NATIVE_BIN]);
  process.stdout.write(`${JSON.stringify({ prepared: { version, source_revision: revision, native_bin: NATIVE_BIN } })}\n`);
}

try {
  const [action] = process.argv.slice(2);
  if (action === 'prepare') prepare();
  else throw new Error('usage: node release/native/managed.mjs prepare');
} catch (error) {
  process.stderr.write(`managed runtime: ${error.message}\n`);
  process.exitCode = 1;
}
