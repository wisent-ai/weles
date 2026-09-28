// Record routes of a real, running Weles API: accounts, the action queue and
// runtime settings Weles keeps in Skarbiec, behind the general API bearer.
// Called by the packaging test against the process it started from the
// compiled payload; every answer is kept in the report.
import assert from 'node:assert/strict';

const RECORD_ROUTES = [
  '/records/accounts/list',
  '/records/accounts/get',
  '/records/accounts/upsert',
  '/records/accounts/update',
  '/records/jobs/enqueue',
  '/records/settings/get',
  '/records/settings/set',
];

export async function checkRecordRoutes({ port, token, reportedRoutes, report }) {
  for (const route of RECORD_ROUTES) {
    assert.ok(reportedRoutes.includes(`POST ${route}`), `${route} missing from ${JSON.stringify(reportedRoutes)}`);
  }
  const recordsAt = (route, body, headers = { authorization: `Bearer ${token}` }) => fetch(
    `http://127.0.0.1:${port}${route}`,
    { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  report.record_routes = [];

  const unauthorized = await recordsAt('/records/accounts/list', {}, {});
  report.record_routes.push({ case: 'no bearer', status: unauthorized.status, body: await unauthorized.json() });
  assert.equal(unauthorized.status, 401);

  const invalid = await recordsAt('/records/accounts/update', { account_id: 'weles-reddit-example-account', patch: { active: 'yes' } });
  const invalidBody = await invalid.json();
  report.record_routes.push({ case: 'non-boolean active', status: invalid.status, body: invalidBody });
  assert.equal(invalid.status, 400, JSON.stringify(invalidBody));
  assert.equal(invalidBody.field, 'patch.active');
}
