#!/usr/bin/env node
/** Both worker publishers consume the native inputs declared in the release recipe. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync, chmodSync, constants, copyFileSync, createReadStream, existsSync,
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { stadoBinary } from '../../src/_shared/skarbiec-runtime.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const OUTPUT = join(ROOT, '.wisent-output');
const PLATFORMS = [
  { os: 'darwin', arch: 'arm64', name: 'darwin-arm64', input: 'jeden-runtime', binaries: ['jeden', 'jeden-sandbox-helper'] },
  { os: 'linux', arch: 'x64', name: 'linux-x64', input: 'jeden-runtime-linux', binaries: ['jeden'] },
];

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function command(program, args) {
  const result = spawnSync(program, args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed (exit ${result.status ?? 'none'}, signal ${result.signal ?? 'none'}): ${result.error?.message || result.stderr || result.stdout || 'no diagnostic output'}`);
  }
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
}

function declaredInput(platform) {
  const manifest = JSON.parse(readFileSync(join(ROOT, '.wisent-release.json'), 'utf8'));
  const input = manifest.inputs?.[platform.input];
  if (!input || !/^stado:\/\//.test(input.uri) || !/^[0-9a-f]{64}$/.test(input.sha256)) {
    throw new Error(`missing immutable native input ${platform.input} in .wisent-release.json`);
  }
  return input;
}

async function verifyArchive(path, input) {
  const actual = await digest(path);
  if (actual !== input.sha256) {
    throw new Error(`native input ${path} has SHA-256 ${actual}; ${input.uri} requires ${input.sha256}`);
  }
}

async function fetchInputs() {
  for (const platform of PLATFORMS) {
    const input = declaredInput(platform);
    const directory = join(OUTPUT, 'native-inputs', platform.name);
    mkdirSync(directory, { recursive: true });
    const archive = join(directory, 'release.tar.gz');
    if (!existsSync(archive) || await digest(archive) !== input.sha256) {
      command(stadoBinary(), ['storage', 'get', input.uri, archive]);
    }
    await verifyArchive(archive, input);
    writeFileSync(join(directory, 'input.json'), `${JSON.stringify(input, null, 2)}\n`);
    process.stdout.write(`${platform.name}: ${input.uri} SHA-256 ${input.sha256}\n`);
  }
}

async function stage(destination, source) {
  const platform = PLATFORMS.find((value) => value.os === process.platform && value.arch === process.arch);
  if (!platform) throw new Error(`no native worker input is declared for ${process.platform}-${process.arch}`);
  const input = declaredInput(platform);
  let unpacked;
  try {
    let root = resolve(source);
    if (statSync(root).isFile()) {
      await verifyArchive(root, input);
      mkdirSync(OUTPUT, { recursive: true });
      unpacked = mkdtempSync(join(OUTPUT, 'native-stage-'));
      command('tar', ['-xzf', root, '-C', unpacked]);
      root = unpacked;
    }
    const output = resolve(destination);
    mkdirSync(output, { recursive: true });
    const binaries = [];
    for (const name of platform.binaries) {
      const binary = join(root, 'bin', name);
      if (!statSync(binary).isFile()) throw new Error(`native input is not a regular executable: ${binary}`);
      accessSync(binary, constants.X_OK);
      const installed = join(output, name);
      copyFileSync(binary, installed);
      chmodSync(installed, 0o755);
      const version = command(installed, ['--version']);
      binaries.push({ name, sha256: await digest(installed), version });
    }
    const receipt = { schema: 'weles.native-runtime.v1', platform: platform.name, input, binaries };
    writeFileSync(join(dirname(output), 'runtime.json'), `${JSON.stringify(receipt, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
  } finally {
    if (unpacked) rmSync(unpacked, { recursive: true, force: true });
  }
}

try {
  const [action, destination, input] = process.argv.slice(2);
  if (action === 'fetch' && !destination) await fetchInputs();
  else if (action === 'stage' && destination && input) await stage(destination, input);
  else throw new Error('usage: node release/native/runtime.mjs fetch | stage <destination-bin-directory> <input-directory-or-archive>');
} catch (error) {
  process.stderr.write(`native runtime: ${error.message}\n`);
  process.exitCode = 1;
}
