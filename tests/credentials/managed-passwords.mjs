import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { evidenceFor } from '../security/evidence.mjs';

const evidence = await evidenceFor('managed-passwords');
const { report, command, request } = evidence;
const route = '/api/v1/credential-operations';
const origins = {
  microsoft: 'https://account.live.com',
  microsoft_entra: 'https://login.microsoftonline.com',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function privateFile(path, contents = true) {
  assert(isAbsolute(path), 'qualification inputs must use absolute paths');
  const metadata = await lstat(path);
  assert(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === process.getuid() &&
      (metadata.mode & 0o077) === 0,
    'qualification inputs must be regular owner-only files',
  );
  return contents ? readFile(path) : undefined;
}
function submission(account, revision) {
  return {
    version: 'skarbiec.credential-operation.v3',
    request_id: randomBytes(32).toString('hex'),
    mode: 'submit',
    action_log_id: null,
    credential_id: account.item,
    operation: 'verify',
    provider: account.provider,
    consumer: `${account.item}-writer`,
    purpose: 'Qualify managed password contract refusal',
    account_email: account.provider === 'microsoft' ? account.email : null,
    directory:
      account.provider === 'microsoft_entra'
        ? { provider: account.provider, ...account.directory }
        : null,
    approval_id: null,
    resume_token: null,
    baseline_revision: revision,
    field: 'password',
    status: 'pending',
    created_at: new Date().toISOString(),
    dry_run: false,
    signup_origin: null,
  };
}
async function refusal(body, code, bearer) {
  const denied = await request(route, body, bearer);
  assert.equal(denied.status, 409);
  assert.equal(denied.value.code, code);
  assert.equal(denied.value.providerEffect, 'none');
  assert.equal(
    denied.value.actionLogId,
    null,
    'refusal must not admit provider work',
  );
  const absent = await request(
    route,
    { ...body, mode: 'status', action_log_id: `credential-${body.request_id}` },
    bearer,
  );
  assert.equal(absent.status, 404);
  assert.equal(absent.value.code, 'WELES_CREDENTIAL_REQUEST_NOT_FOUND');
}
try {
  const { values } = parseArgs({
    options: {
      fixture: { type: 'string' },
      'admission-report': { type: 'string' },
    },
  });
  const fixturePath = await realpath(resolve(values.fixture || ''));
  const build = await realpath(new URL('../../build', import.meta.url));
  assert(
    fixturePath.startsWith(build + sep),
    'fixture must be inside this checkout’s ignored build directory',
  );
  const bytes = await privateFile(fixturePath);
  const fixture = JSON.parse(bytes.toString());
  assert.equal(
    fixture.dedicated,
    true,
    'use only dedicated accounts and a Stado-selected dedicated Weles host',
  );
  assert.deepEqual(
    [...new Set(fixture.accounts.map((account) => account.provider))].sort(),
    ['microsoft', 'microsoft_entra'],
  );
  assert.equal(
    new Set(fixture.accounts.map((account) => account.item)).size,
    fixture.accounts.length,
    'accounts must name distinct managed credentials',
  );
  assert.equal(typeof fixture.execution_host, 'string');
  assert.equal(typeof fixture.skarbiec_caller, 'string');
  assert(isAbsolute(fixture.skarbiec_binary));
  await privateFile(fixture.skarbiec_token_file, false);
  const bearer = `Bearer ${(await privateFile(fixture.weles_bearer_file)).toString().trim()}`;
  report.fixture = fixturePath;
  report.fixture_sha256 = hash(bytes);
  report.source_diff = command('git', [
    'diff',
    'HEAD',
    '--',
    'src',
    'release',
    'tests',
  ]);
  assert.equal(
    report.source_diff,
    '',
    'qualification requires committed source',
  );
  assert.equal(
    command('git', [
      'ls-files',
      '--others',
      '--exclude-standard',
      '--',
      'src',
      'release',
      'tests',
    ]).trim(),
    '',
  );
  report.skarbiec = {
    binary: fixture.skarbiec_binary,
    sha256: hash(await readFile(fixture.skarbiec_binary)),
    version: command(fixture.skarbiec_binary, ['--version']),
  };
  const authority = [
    '--as',
    fixture.skarbiec_caller,
    '--token-file',
    fixture.skarbiec_token_file,
  ];
  const status = (item) =>
    JSON.parse(
      command(fixture.skarbiec_binary, [
        'credential',
        'status',
        item,
        ...authority,
      ]),
    );
  await evidence.connect();
  const health = await request('/healthz');
  assert.equal(health.status, 200);
  report.worker_revision = health.value.sourceRevision;
  assert.equal(
    report.worker_revision,
    report.source_revision,
    'the managed worker must serve the exact source under qualification',
  );
  if (values['admission-report']) {
    const previous = JSON.parse(
      await readFile(resolve(values['admission-report']), 'utf8'),
    );
    assert.equal(previous.status, 'awaiting_observation');
    assert.equal(previous.source_revision, report.source_revision);
    assert.equal(previous.worker_revision, report.worker_revision);
    assert.equal(previous.fixture_sha256, report.fixture_sha256);
    assert.equal(previous.skarbiec.sha256, report.skarbiec.sha256);
    report.accounts = previous.accounts;
    report.previous_report = resolve(values['admission-report']);
  } else {
    report.accounts = [];
  }
  for (const account of fixture.accounts) {
    let recorded = report.accounts.find((entry) => entry.item === account.item);
    if (recorded?.verified) continue;
    if (!recorded) {
      const before = status(account.item);
      assert.equal(before.credential, account.item);
      assert.equal(
        before.lifecycle_state,
        'managed',
        'qualification requires an existing real managed credential',
      );
      assert(
        !before.request_id || before.settled === true,
        'do not replace an unfinished credential operation',
      );
      if (account.provider === 'microsoft_entra') {
        for (const key of ['tenant_id', 'principal_object_id', 'account_upn'])
          assert.equal(before.directory?.[key], account.directory[key]);
      }
      const wrongWriter = submission(account, before.revision);
      wrongWriter.consumer += '-not-granted';
      await refusal(wrongWriter, 'WELES_CREDENTIAL_CONTRACT_MISMATCH', bearer);
      const wrongOrigin = submission(account, before.revision);
      wrongOrigin.signup_origin = 'https://example.invalid';
      await refusal(wrongOrigin, 'WELES_CREDENTIAL_ORIGIN_MISMATCH', bearer);
      const undeclared = submission(account, before.revision);
      undeclared.credential_id = `qualification-${randomBytes(16).toString('hex')}`;
      undeclared.consumer = `${undeclared.credential_id}-writer`;
      await refusal(undeclared, 'WELES_CREDENTIAL_CONTRACT_MISMATCH', bearer);
      const unchanged = status(account.item);
      assert.equal(unchanged.revision, before.revision);
      assert.equal(
        unchanged.request_id,
        before.request_id,
        'refused admission must not replace the real operation',
      );
      recorded = {
        item: account.item,
        provider: account.provider,
        before,
        refusals_verified: true,
      };
      report.accounts.push(recorded);
      const expectations =
        account.provider === 'microsoft_entra'
          ? [
              '--expect-tenant',
              account.directory.tenant_id,
              '--expect-object-id',
              account.directory.principal_object_id,
              '--expect-upn',
              account.directory.account_upn,
            ]
          : [];
      recorded.admission = JSON.parse(
        command(fixture.skarbiec_binary, [
          'credential',
          'verify',
          account.item,
          '--consumer',
          `${account.item}-writer`,
          '--purpose',
          'Qualify deployment-owned password declaration',
          ...expectations,
          ...authority,
        ]),
      );
      assert.equal(recorded.admission.credential, account.item);
      assert.equal(recorded.admission.operation, 'verify');
      assert.equal(recorded.admission.ok, true);
      assert.match(recorded.admission.request_id, /^[a-f0-9]{64}$/);
    }
    const observed = status(account.item);
    recorded.observed = observed;
    assert.equal(
      observed.request_id,
      recorded.admission.request_id,
      'another operation cannot satisfy this qualification',
    );
    assert.equal(observed.credential, account.item);
    assert.equal(observed.operation, 'verify');
    if (observed.settled !== true) {
      report.status = 'awaiting_observation';
      report.error = {
        message:
          'The real provider verification is not settled. Continue this exact request with --admission-report; do not submit another verification.',
      };
      process.exitCode = 1;
      break;
    }
    const runId = observed.weles?.action_log_id;
    assert.equal(typeof runId, 'string');
    evidence.runs.add(runId);
    assert.equal(observed.externally_verified, true);
    assert.equal(observed.lifecycle_state, 'managed');
    assert.equal(observed.weles.provider, account.provider);
    assert.equal(observed.weles.execution_host, fixture.execution_host);
    const inventory = await request(
      `/diagnostics/${encodeURIComponent(runId)}`,
    );
    assert.equal(inventory.status, 200);
    assert(
      inventory.value.files.some((file) =>
        /\.(?:png|jpe?g|webp)$/.test(file.path),
      ),
      'provider verification must retain supported visual evidence',
    );
    const captures = inventory.value.files.filter((file) =>
      /(^|\/)credential_capture\.json$/.test(file.path),
    );
    assert.equal(
      captures.length,
      1,
      'one managed operation must retain one unambiguous capture acknowledgement',
    );
    assert(
      captures[0].download_url.startsWith(
        `/diagnostics/${encodeURIComponent(runId)}/file?path=`,
      ),
    );
    const capture = await request(captures[0].download_url);
    assert.equal(capture.status, 200);
    assert.equal(capture.value.requestId, observed.request_id);
    assert.equal(capture.value.vaultItemId, account.item);
    assert.equal(capture.value.operation, 'verify');
    assert.equal(capture.value.field, 'password');
    assert.equal(capture.value.sourceOrigin, origins[account.provider]);
    if (account.provider === 'microsoft_entra') {
      for (const key of ['tenant_id', 'principal_object_id', 'account_upn'])
        assert.equal(observed.receipt?.[key], account.directory[key]);
      assert.equal(observed.receipt.request_id, observed.request_id);
    }
    const persisted = status(account.item);
    assert.equal(persisted.externally_verified, true);
    assert.equal(persisted.request_id, observed.request_id);
    assert.equal(persisted.revision, observed.revision);
    assert.deepEqual(persisted.receipt, observed.receipt);
    recorded.persisted = persisted;
    recorded.verified = true;
  }
  assert.equal(
    hash(await readFile(fixture.skarbiec_binary)),
    report.skarbiec.sha256,
    'Skarbiec executable changed during qualification',
  );
  assert.equal(
    command('git', ['rev-parse', 'HEAD']).trim(),
    report.source_revision,
  );
  assert.equal(
    command('git', ['diff', 'HEAD', '--', 'src', 'release', 'tests']),
    '',
  );
  if (
    report.accounts.length === fixture.accounts.length &&
    report.accounts.every((account) => account.verified)
  )
    report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  process.exitCode = 1;
} finally {
  await evidence.finish();
}
