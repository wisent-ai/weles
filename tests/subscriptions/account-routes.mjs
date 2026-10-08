// The admission and refusals of the two account runs Brama orders, against
// the deployed managed worker. Nothing here starts a browser or spends money:
// every request is one Weles must refuse before a run is admitted, and the
// test proves that no run id came back.
import assert from 'node:assert/strict';
import { constants as http } from 'node:http2';
import { evidenceFor } from '../security/evidence.mjs';

const evidence = await evidenceFor('subscriptions');
const { report, request, command } = evidence;
try {
  await evidence.connect();
  const health = await request('/healthz');
  assert.equal(health.status, http.HTTP_STATUS_OK);
  assert.equal(health.value.sourceRevision, report.source_revision);

  // Brama's admission credential, read by the role its item plays, exactly
  // as Brama reads it.
  const token = command(
    'stado',
    ['credentials', 'get', '--role', 'brama-weles-reauth', '--field', 'token'],
    true,
  ).trim();
  assert.ok(token, 'the Brama reauthentication credential must be available');
  const bearer = `Bearer ${token}`;
  const refused = (answer, error) => {
    assert.equal(answer.status, http.HTTP_STATUS_BAD_REQUEST);
    assert.equal(answer.value.error, error);
    assert.equal(
      answer.value.run_id,
      undefined,
      'a refusal must not start a run',
    );
  };

  // The general worker bearer does not admit a purchase.
  const general = await request('/subscriptions/acquire', {
    provider: 'claude',
    subscription_id: 'claude-code-acquired-test',
    plan_tier: 'default_claude_max_20x',
    reason: 'admission test',
  });
  assert.equal(general.status, http.HTTP_STATUS_UNAUTHORIZED);
  assert.equal(general.value.error, 'unauthorized');

  refused(
    await request(
      '/subscriptions/acquire',
      {
        provider: 'kimi',
        subscription_id: 'kimi-acquired-test',
        plan_tier: 'any',
        reason: 'refusal test',
      },
      bearer,
    ),
    'provider_unsupported',
  );

  const noPlan = await request(
    '/subscriptions/acquire',
    {
      provider: 'claude',
      subscription_id: 'claude-code-acquired-test',
      reason: 'refusal test',
    },
    bearer,
  );
  refused(noPlan, 'acquisition_incomplete');
  assert.match(noPlan.value.message, /plan_tier/);

  // Only the provider's own authorize page, redirecting to the harness's own
  // listener, is ever driven.
  refused(
    await request(
      '/reauth/authorize',
      {
        provider: 'claude',
        subscription_id: 'claude-code-acquired-test',
        authorize_url:
          'https://example.com/oauth/authorize?redirect_uri=http%3A%2F%2Flocalhost%2Fcallback',
      },
      bearer,
    ),
    'authorize_url_refused',
  );
  const leaking = await request(
    '/reauth/authorize',
    {
      provider: 'claude',
      subscription_id: 'claude-code-acquired-test',
      authorize_url:
        'https://claude.ai/oauth/authorize?redirect_uri=https%3A%2F%2Fexample.com%2Fcallback',
    },
    bearer,
  );
  refused(leaking, 'authorize_url_refused');
  assert.match(leaking.value.message, /example\.com/);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  process.exitCode = 1; // https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/stdlib.h.html
} finally {
  await evidence.finish();
}
