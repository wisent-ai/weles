#!/usr/bin/env node
/** Both worker publishers consume the native inputs declared in the release recipe. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { stadoBinary } from '../../src/_shared/skarbiec-runtime.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const OUTPUT = join(ROOT, '.wisent-output');
const EXIT_SUCCESS = 0; // https://pubs.opengroup.org/onlinepubs/9799919799/functions/exit.html EXIT_SUCCESS
const EXIT_FAILURE = 1; // https://pubs.opengroup.org/onlinepubs/9799919799/functions/exit.html EXIT_FAILURE
// A SHA-256 digest in hex is as long as the hex of any SHA-256 digest.
const SHA256_HEX_LENGTH = createHash('sha256').digest('hex').length;
// The receipts are indented as the rest of the release JSON is.
const JSON_INDENT = '  ';
const PLATFORMS = [
  {
    os: 'darwin',
    arch: 'arm64',
    name: 'darwin-arm64',
    input: 'jeden-runtime',
    binaries: ['jeden', 'jeden-sandbox-helper'],
  },
  {
    os: 'linux',
    arch: 'x64',
    name: 'linux-x64',
    input: 'jeden-runtime-linux',
    binaries: ['jeden'],
  },
];

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

function command(program, args) {
  const line = `${program} ${args.join(' ')}`;
  const result = spawnSync(program, args, { cwd: ROOT, encoding: 'utf8' });
  if (result.error) {
    throw new Error(`${line} could not run: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== EXIT_SUCCESS) {
    const ended =
      result.status === null
        ? `was ended by signal ${result.signal}`
        : `exited ${result.status}`;
    const said = [result.stderr, result.stdout].filter(Boolean).join('\n');
    throw new Error(
      said ? `${line} ${ended}: ${said}` : `${line} ${ended} and printed nothing`,
    );
  }
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout.trim();
}

function declaredInput(platform) {
  const manifest = JSON.parse(
    readFileSync(join(ROOT, '.wisent-release.json'), 'utf8'),
  );
  const input = manifest.inputs?.[platform.input];
  if (
    !input ||
    !/^stado:\/\//.test(input.uri) ||
    typeof input.sha256 !== 'string' ||
    input.sha256.length !== SHA256_HEX_LENGTH ||
    !/^[\da-f]+$/.test(input.sha256)
  ) {
    throw new Error(
      `missing immutable native input ${platform.input} in .wisent-release.json`,
    );
  }
  return input;
}

async function verifyArchive(path, input) {
  const actual = await digest(path);
  if (actual !== input.sha256) {
    throw new Error(
      `native input ${path} has SHA-256 ${actual}; ${input.uri} requires ${input.sha256}`,
    );
  }
}

async function fetchInputs() {
  for (const platform of PLATFORMS) {
    const input = declaredInput(platform);
    const directory = join(OUTPUT, 'native-inputs', platform.name);
    mkdirSync(directory, { recursive: true });
    const archive = join(directory, 'release.tar.gz');
    if (!existsSync(archive) || (await digest(archive)) !== input.sha256) {
      command(stadoBinary(), ['storage', 'get', input.uri, archive]);
    }
    await verifyArchive(archive, input);
    writeFileSync(
      join(directory, 'input.json'),
      `${JSON.stringify(input, null, JSON_INDENT)}\n`,
    );
    process.stdout.write(
      `${platform.name}: ${input.uri} SHA-256 ${input.sha256}\n`,
    );
  }
}

/** The platform this host is, and the input declared for it. */
function localPlatform() {
  const platform = PLATFORMS.find(
    (value) => value.os === process.platform && value.arch === process.arch,
  );
  if (!platform)
    throw new Error(
      `no native worker input is declared for ${process.platform}-${process.arch}`,
    );
  return platform;
}

/**
 * The directory a Stado build receives a declared input in:
 * `WISENT_INPUT_<MOUNT>_DIR`, the mount upper-cased with `-` as `_`. Each
 * platform's build reads its own platform's input, so a linux builder stages
 * the linux runtime and never the darwin one.
 */
function stadoInputDirectory(input) {
  const variable = `WISENT_INPUT_${input.mount.replaceAll('-', '_').toUpperCase()}_DIR`;
  const directory = process.env[variable];
  if (!directory) {
    throw new Error(
      `${variable} is not set: a Stado build receives this host's declared native input ${input.uri} there`,
    );
  }
  return directory;
}

async function stage(destination, source) {
  const platform = localPlatform();
  const input = declaredInput(platform);
  let unpacked;
  try {
    let root = resolve(source ?? stadoInputDirectory(input));
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
      if (!statSync(binary).isFile())
        throw new Error(`native input is not a regular executable: ${binary}`);
      accessSync(binary, constants.X_OK);
      const installed = join(output, name);
      copyFileSync(binary, installed);
      // The staged binary keeps the executable mode it was published with.
      chmodSync(installed, statSync(binary).mode);
      const version = command(installed, ['--version']);
      binaries.push({ name, sha256: await digest(installed), version });
    }
    const receipt = {
      schema: 'weles.native-runtime.v1',
      platform: platform.name,
      input,
      binaries,
    };
    writeFileSync(
      join(dirname(output), 'runtime.json'),
      `${JSON.stringify(receipt, null, JSON_INDENT)}\n`,
    );
    process.stdout.write(`${JSON.stringify(receipt, null, JSON_INDENT)}\n`);
  } finally {
    if (unpacked) rmSync(unpacked, { recursive: true, force: true });
  }
}

try {
  const {
    positionals: [action, destination, input],
  } = parseArgs({ allowPositionals: true, strict: true });
  if (action === 'fetch' && !destination) await fetchInputs();
  else if (action === 'stage' && destination) await stage(destination, input);
  else {
    throw new Error(
      'usage: node release/native/runtime.mjs fetch ' +
        '| stage <destination-bin-directory> [<input-directory-or-archive>] ' +
        "(without one, the input Stado hands the build for this host's platform)",
    );
  }
} catch (error) {
  process.stderr.write(`native runtime: ${error.message}\n`);
  process.exitCode = EXIT_FAILURE;
}
