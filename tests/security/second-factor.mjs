// Continues Brama's real journey on the same managed worker. No local browser,
// manufactured approval, provider substitute or authenticator replacement.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { evidenceFor } from './evidence.mjs';

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
  report.source_sha256 = createHash('sha256')
    .update(
      await readFile(
        new URL(
          '../../src/worker/weles-api-server/routes/trajectory-routes.mjs',
          import.meta.url,
        ),
      ),
    )
    .digest('hex');
  await evidence.connect();
  const health = await request('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.value.sourceRevision, report.source_revision);

  const denied = await request('/runs', undefined, null);
  assert.equal(denied.status, 401);
  assert.equal(denied.value.error, 'unauthorized');
  const absent = await request(`/runs/${randomUUID()}`);
  assert.equal(absent.status, 404);
  assert.equal(absent.value.error, 'run_not_found');
  const invalid = await request(`/runs/${randomUUID()}/answer`, {
    answer: 'cancel',
    detail: '',
  });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.value.error, 'invalid_answer');

  if (authentication.second_factor === 'phone') {
    const expected = authentication.phone_request;
    assert.ok(
      expected?.id,
      'the sign-in must have opened an actual phone request',
    );
    const persisted = await request(`/runs/${authentication.sign_in.run_id}`);
    assert.equal(persisted.status, 200);
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
    assert.equal(finished.status, 409, 'a finished run waits for no answer');
    assert.equal(finished.value.error, 'run_not_running_here');
    const shown = JSON.parse(
      command(process.env.WELES_REAL_BIN || 'weles', [
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
  // It is read by the role its item plays, the same role the launcher acquires.
  const token =
    process.env.BRAMA_WELES_REAUTH_TOKEN?.trim() ||
    command(
      process.env.BRAMA_STADO_BIN || 'stado',
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
  assert.equal(before.status, 200);
  const stale = await request(
    '/reauth/enrol-authenticator',
    {
      ...identity,
      account_revision: randomUUID(),
    },
    bearer,
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.value.error, 'skarbiec_identity_changed');
  assert.equal(
    stale.value.run_id,
    undefined,
    'a stale identity must not start a browser',
  );

  if (authentication.second_factor === 'authenticator') {
    // The real sign-in just used this account's existing authenticator. Two
    // concurrent callers must join one refusal, not race to replace that factor.
    const answers = await Promise.all(
      [0, 1].map(() =>
        request(
          '/reauth/enrol-authenticator',
          {
            ...identity,
            account_revision: before.value.account_revision,
          },
          bearer,
        ),
      ),
    );
    for (const refused of answers) {
      assert.equal(refused.status, 502);
      assert.equal(
        refused.value.blocked,
        'authenticator_replacement_requires_consent',
      );
      assert.notEqual(refused.value.result?.seed_written, true);
    }
    assert.equal(answers[0].value.run_id, answers[1].value.run_id);
    assert.notEqual(answers[0].value.coalesced, answers[1].value.coalesced);
  }
  const after = await request('/reauth/resolve', identity, bearer);
  assert.equal(after.status, 200);
  assert.equal(
    after.value.account_revision,
    before.value.account_revision,
    'refused enrolment must not change the account or its authenticator',
  );
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
