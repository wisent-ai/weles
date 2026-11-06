// Continues Brama's real journey on the same managed worker. No local browser,
// manufactured approval, provider substitute or authenticator replacement.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { constants as http } from 'node:http2';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { STATUS, evidenceFor } from './evidence.mjs';

/** The command `setting` names, else the one of that name on PATH. */
function commandNamed(setting, name) {
  const stated = process.env[setting]?.trim();
  return stated ? stated : name;
}

const evidence = await evidenceFor('second-factor');
const { report, request, command } = evidence;
try {
  const { values } = parseArgs({
    options: { 'authentication-report': { type: 'string' } },
  });
  assert.ok(
    values['authentication-report'],
    '--authentication-report must name a fresh passed Brama journey',
  );
  const authentication = JSON.parse(
    await readFile(values['authentication-report'], 'utf8'),
  );
  assert.equal(authentication.status, 'passed');
  assert.equal(authentication.worker_revision, report.source_revision);
  assert.equal(authentication.sign_in.second_factor.required, true);
  assert.ok(authentication.sign_in.run_id);
  evidence.runs.add(authentication.sign_in.run_id);
  report.authentication_report = resolve(values['authentication-report']);
  // The enrolment route this journey exercises, by its own source.
  report.source_sha256 = createHash('sha256')
    .update(
      await readFile(
        new URL(
          '../../src/worker/weles-api-server/routes/trajectory/authenticator-enrolment.mjs',
          import.meta.url,
        ),
      ),
    )
    .digest('hex');
  await evidence.connect();
  const health = await request('/healthz');
  assert.equal(health.status, http.HTTP_STATUS_OK);
  assert.equal(health.value.sourceRevision, report.source_revision);

  const denied = await request('/runs', undefined, null);
  assert.equal(denied.status, http.HTTP_STATUS_UNAUTHORIZED);
  assert.equal(denied.value.error, 'unauthorized');
  const absent = await request(`/runs/${randomUUID()}`);
  assert.equal(absent.status, http.HTTP_STATUS_NOT_FOUND);
  assert.equal(absent.value.error, 'run_not_found');
  const invalid = await request(`/runs/${randomUUID()}/answer`, {
    answer: 'cancel',
    detail: '',
  });
  assert.equal(invalid.status, http.HTTP_STATUS_BAD_REQUEST);
  assert.equal(invalid.value.error, 'invalid_answer');

  if (authentication.second_factor === 'phone') {
    const expected = authentication.phone_request;
    assert.ok(
      expected?.id,
      'the sign-in must have opened an actual phone request',
    );
    const persisted = await request(`/runs/${authentication.sign_in.run_id}`);
    assert.equal(persisted.status, http.HTTP_STATUS_OK);
    const asked = persisted.value.record?.operator_request;
    assert.equal(
      asked?.id,
      expected.id,
      'the sign-in run must record the phone request it waited on',
    );
    assert.equal(asked.account, authentication.account);
    assert.ok(
      Date.parse(asked.opened_at) >=
        Date.parse(authentication.authentication_started_at),
    );
    assert.equal(persisted.value.record.ok, true);
    const finished = await request(
      `/runs/${authentication.sign_in.run_id}/answer`,
      { answer: 'approved', detail: '' },
    );
    assert.equal(
      finished.status,
      http.HTTP_STATUS_CONFLICT,
      'a finished run waits for no answer',
    );
    assert.equal(finished.value.error, 'run_not_running_here');
    const shown = JSON.parse(
      command(commandNamed('WELES_REAL_BIN', 'weles'), [
        'runs',
        'show',
        authentication.sign_in.run_id,
        '--json',
      ]),
    );
    assert.equal(shown.record.operator_request.id, expected.id);
    assert.equal(shown.record.operator_request.host, asked.host);
  }

  // Brama's credential is distinct from the general worker bearer. Its value
  // stays in memory and is never written into the retained command output.
  // It is read by the role its item plays, the same role the launcher
  // acquires, unless the environment states it.
  const statedToken = process.env.BRAMA_WELES_REAUTH_TOKEN?.trim();
  const token = statedToken
    ? statedToken
    : command(
        commandNamed('BRAMA_STADO_BIN', 'stado'),
        [
          'credentials',
          'get',
          '--role',
          'brama-weles-reauth',
          '--field',
          'token',
        ],
        true,
      ).trim();
  assert.ok(token, 'the Brama reauthentication credential must be available');
  const bearer = `Bearer ${token}`;
  const identity = {
    provider:
      authentication.sign_in.provider === 'claude-code'
        ? 'claude'
        : authentication.sign_in.provider,
    subscription_id: authentication.subscription_id,
    login_item: authentication.sign_in.login_item,
  };
  const before = await request('/reauth/resolve', identity, bearer);
  assert.equal(before.status, http.HTTP_STATUS_OK);
  const stale = await request(
    '/reauth/enrol-authenticator',
    { ...identity, account_revision: randomUUID() },
    bearer,
  );
  assert.equal(stale.status, http.HTTP_STATUS_CONFLICT);
  assert.equal(stale.value.error, 'skarbiec_identity_changed');
  assert.equal(
    stale.value.run_id,
    undefined,
    'a stale identity must not start a browser',
  );

  if (authentication.second_factor === 'authenticator') {
    // The real sign-in just used this account's existing authenticator. Two
    // concurrent callers must join one refusal, not race to replace that factor.
    const enrol = () =>
      request(
        '/reauth/enrol-authenticator',
        { ...identity, account_revision: before.value.account_revision },
        bearer,
      );
    const [first, second] = await Promise.all([enrol(), enrol()]);
    for (const refused of [first, second]) {
      assert.equal(refused.status, http.HTTP_STATUS_BAD_GATEWAY);
      assert.equal(
        refused.value.blocked,
        'authenticator_replacement_requires_consent',
      );
      assert.notEqual(refused.value.result?.seed_written, true);
    }
    assert.equal(first.value.run_id, second.value.run_id);
    assert.notEqual(first.value.coalesced, second.value.coalesced);
  }
  const after = await request('/reauth/resolve', identity, bearer);
  assert.equal(after.status, http.HTTP_STATUS_OK);
  assert.equal(
    after.value.account_revision,
    before.value.account_revision,
    'refused enrolment must not change the account or its authenticator',
  );
  report.status = STATUS.passed;
} catch (error) {
  report.status = STATUS.failed;
  report.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  // Thrown on, after the report is finished, so the journey exits failed.
  throw error;
} finally {
  await evidence.finish();
}
