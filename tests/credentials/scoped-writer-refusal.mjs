// The scoped Skarbiec writer keeps the actual failure of the Stado program it
// runs. Two real executions, no stand-in for Stado:
// - a Stado path whose interpreter does not exist: the kernel refuses to run it,
//   so no stderr is captured and the spawn error must survive as the cause;
// - the real Stado named by STADO_BIN, run in an isolated HOME that holds no
//   vault: it runs, so there is no spawn error, and its stderr is quoted.
// Required: STADO_BIN (absolute path of the real stado binary).
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evidenceFor } from '../security/evidence.mjs';

const evidence = await evidenceFor('scoped-writer-refusal');
const { report } = evidence;
const OWNER_ONLY = constants.S_IRWXU;
const home = join(
  fileURLToPath(new URL('../../build/real-tests/', import.meta.url)),
  'scoped-writer-refusal-home',
  randomUUID(),
);
let failure;

function required(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
}

function refusalOf(write) {
  try {
    write();
  } catch (error) {
    return error;
  }
  return undefined;
}

async function identity(path) {
  const resolved = await realpath(path);
  return {
    path: resolved,
    sha256: createHash('sha256')
      .update(await readFile(resolved))
      .digest('hex'),
  };
}

async function retainedState(directory, credentials) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await retainedState(path, credentials)));
    } else if (entry.isFile()) {
      const bytes = await readFile(path);
      for (const value of credentials)
        assert.ok(
          !bytes.includes(value),
          `a refused write persisted a credential in ${path}`,
        );
      files.push({
        path,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    } else {
      assert.fail(
        `the isolated fixture contains an unexpected file type at ${path}`,
      );
    }
  }
  return files;
}

try {
  const stado = required('STADO_BIN');
  assert.ok(isAbsolute(stado), 'STADO_BIN must be an absolute path');
  report.source_status = evidence.command('git', [
    'status',
    '--porcelain',
    '--untracked-files=all',
  ]);
  assert.equal(
    report.source_status,
    '',
    'the executed checkout must be clean and committed',
  );
  report.source_tree = evidence
    .command('git', ['rev-parse', 'HEAD^{tree}'])
    .trim();
  report.executables = {
    node: await identity(process.execPath),
    stado: await identity(stado),
  };
  report.stado_version = evidence.command(stado, ['--version']).trim();
  report.executed_modules = await Promise.all(
    [
      import.meta.url,
      new URL('../security/evidence.mjs', import.meta.url),
      new URL('../../src/_shared/scoped-secrets.mjs', import.meta.url),
      new URL('../../src/_shared/skarbiec-runtime.mjs', import.meta.url),
      new URL('../../src/_shared/local-credentials.mjs', import.meta.url),
      new URL(
        '../../dist/secrets/scoped-service/transport.js',
        import.meta.url,
      ),
      new URL(
        '../../dist/secrets/scoped-service/catalog/services.js',
        import.meta.url,
      ),
    ].map((path) => identity(new URL(path))),
  );
  report.qualified_surface =
    'shared ESM writer refusal only; not acquired or reader paths';
  delete process.env.WELES_CREDENTIALS_FILE;
  delete process.env.WELES_STADO_BIN;

  await mkdir(home, { recursive: true, mode: OWNER_ONLY });
  process.env.HOME = home;

  const { writeScopedSecretItem } = await import(
    '../../src/_shared/scoped-secrets.mjs'
  );
  const { SERVICE_CONTRACTS } = await import(
    '../../dist/secrets/scoped-service/catalog/services.js'
  );
  const writable = Object.entries(SERVICE_CONTRACTS).find(
    ([, service]) => service.kind,
  );
  assert.ok(writable, 'the catalog declares no service Weles writes');
  const [serviceName, service] = writable;
  const fields = Object.fromEntries(
    Object.keys(service.fields).map((field) => [field, randomUUID()]),
  );

  // The program cannot be executed at all.
  const unrunnable = join(home, 'stado-without-interpreter');
  await writeFile(unrunnable, `#!${join(home, 'absent', 'interpreter')}\n`);
  await chmod(unrunnable, OWNER_ONLY);
  process.env.WELES_STADO_BIN = unrunnable;
  const notRun = refusalOf(() => writeScopedSecretItem(serviceName, fields));
  report.operations.push({
    case: 'unrunnable-program',
    program: unrunnable,
    message: notRun?.message,
    cause: notRun?.cause?.message,
    cause_code: notRun?.cause?.code,
    execution: notRun?.execution,
  });
  assert.ok(
    notRun instanceof Error,
    'an unrunnable Stado must refuse the write',
  );
  assert.ok(
    !(notRun instanceof TypeError),
    `the actual spawn failure was masked: ${notRun.message}`,
  );
  assert.ok(notRun.cause, 'the spawn error must be kept as the cause');
  assert.equal(notRun.execution.program, unrunnable);
  assert.equal(notRun.execution.program, notRun.cause.path);
  assert.equal(notRun.execution.status, null);
  assert.ok(
    notRun.message.includes(notRun.cause.message),
    'the refusal must quote the spawn error',
  );

  // A program that runs, echoes the values it was handed to stderr and then
  // refuses: every written value is redacted in the message and the record.
  // The values carry a quote and a backslash, which the JSON the helper reads
  // escapes, so neither the written form nor the escaped one may remain.
  const escaping = Object.fromEntries(
    Object.keys(service.fields).map((field) => [
      field,
      `${randomUUID()}"\\${randomUUID()}`,
    ]),
  );
  const echoing = join(home, 'stado-echoing-its-input');
  await writeFile(
    echoing,
    [
      `#!${process.execPath}`,
      "const { readFileSync, writeSync } = require('node:fs');",
      'writeSync(process.stderr.fd, readFileSync(process.stdin.fd));',
      "throw new Error('refusing after echoing its input');",
      '',
    ].join('\n'),
  );
  await chmod(echoing, OWNER_ONLY);
  process.env.WELES_STADO_BIN = echoing;
  const echoed = refusalOf(() => writeScopedSecretItem(serviceName, escaping));
  report.operations.push({
    case: 'echoing-program',
    program: echoing,
    message: echoed?.message,
    execution: echoed?.execution,
  });
  assert.ok(
    echoed instanceof Error,
    'a refusing program must refuse the write',
  );
  assert.equal(echoed.execution.stderrCaptured, true);
  assert.ok(
    echoed.execution.status,
    'the echoing program must exit with a refusal',
  );
  assert.ok(
    echoed.execution.stderr.includes('[redacted]'),
    'the echoed values must be redacted in place',
  );
  for (const value of Object.values(escaping)) {
    for (const form of [value, JSON.stringify(value)]) {
      const body = form.replace(/^"|"$/g, '');
      assert.ok(
        !echoed.message.includes(body),
        'the refusal quoted a written value',
      );
      assert.ok(
        !echoed.execution.stderr.includes(body),
        'the execution record kept a written value',
      );
    }
  }

  // The real Stado runs and refuses in its own words.
  process.env.WELES_STADO_BIN = stado;
  const refused = refusalOf(() => writeScopedSecretItem(serviceName, fields));
  report.operations.push({
    case: 'real-stado-refusal',
    program: stado,
    message: refused?.message,
    execution: refused?.execution,
  });
  assert.ok(refused instanceof Error, 'Stado without a vault must refuse');
  assert.equal(refused.execution.program, stado);
  assert.ok(
    Number.isInteger(refused.execution.pid) && refused.execution.pid,
    'the real credential command must have an observed child PID',
  );
  assert.ok(
    Number.isInteger(refused.execution.status) && refused.execution.status,
    'the actual Stado credential command must exit with a refusal',
  );
  assert.equal(refused.execution.signal, null);
  assert.equal(refused.execution.stderrCaptured, true);
  for (const value of Object.values(fields))
    assert.ok(
      !refused.message.includes(value),
      'the refusal must not carry the credential',
    );

  report.home_entries = await readdir(home);
  report.persisted_files = await retainedState(home, Object.values(fields));
  assert.deepEqual(await identity(stado), report.executables.stado);
  for (const module of report.executed_modules)
    assert.deepEqual(await identity(module.path), module);
  assert.equal(
    evidence.command('git', ['rev-parse', 'HEAD^{tree}']).trim(),
    report.source_tree,
    'the checkout tree changed during execution',
  );
  assert.equal(
    evidence.command('git', ['status', '--porcelain', '--untracked-files=all']),
    '',
    'the executed checkout changed during qualification',
  );
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = error.stack ?? String(error);
  failure = error;
} finally {
  try {
    await rm(home, { recursive: true, force: true });
  } catch (error) {
    report.status = 'failed';
    report.cleanup_error = error.stack ?? String(error);
    failure = failure
      ? new AggregateError(
          [failure, error],
          'qualification and fixture cleanup failed',
        )
      : error;
  }
  try {
    await evidence.finish();
  } catch (error) {
    report.status = 'failed';
    report.publication_error = error.stack ?? String(error);
    failure = failure
      ? new AggregateError(
          [failure, error],
          'qualification and report publication failed',
        )
      : error;
  }
}
if (failure) throw failure;
