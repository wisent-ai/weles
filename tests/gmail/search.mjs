import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { evidenceFor } from '../security/evidence.mjs';

// The configured Stado-selected executor must hold a dedicated Gmail fixture.
// This runner only lists matching rows; it never opens or marks a message read.
const evidence = await evidenceFor('gmail-search');
const { report, request } = evidence;
report.scope = 'real_managed_gmail_search';
report.browser_flow = 'not_run';
let prerequisites = false;

async function run(params) {
  const admitted = await request('/run', {
    action: 'gmail_login_search', params: { ...params, credential_service: 'gmail', open: false }, detached: true,
  });
  assert.equal(admitted.status, 202, JSON.stringify(admitted.value));
  const id = admitted.value.detached_run;
  assert.match(id, /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
  const terminal = await request(`/diagnostics/${encodeURIComponent(id)}/file?path=run-result.json&wait=terminal`);
  assert.equal(terminal.status, 200, JSON.stringify(terminal.value));
  return terminal.value;
}

function listedRows(text) {
  const rows = [];
  let current;
  for (const line of text.split('\n')) {
    if (/^#\d+ \| /.test(line)) {
      current = {};
      rows.push(current);
    } else if (current && line.startsWith('     SUBJ: ')) {
      current.subject = line.slice('     SUBJ: '.length);
    } else if (current && line.startsWith('     SNIP: ')) {
      current.snippet = line.slice('     SNIP: '.length);
    }
  }
  return rows;
}

try {
  const { values } = parseArgs({ options: {
    query: { type: 'string' }, 'expected-subject': { type: 'string' },
    'expected-snippet': { type: 'string' },
  } });
  for (const key of ['query', 'expected-subject', 'expected-snippet']) {
    assert.ok(values[key]?.trim(), `--${key} must describe a real message in the dedicated Gmail fixture`);
  }
  report.fixture = {
    query: values.query, expected_subject: values['expected-subject'],
    expected_snippet: values['expected-snippet'], credential_service: 'gmail',
  };
  await evidence.connect();
  const health = await request('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.value.sourceRevision, report.source_revision,
    'qualification requires the exact source revision on the managed executor');
  prerequisites = true;

  report.browser_flow = 'preflight_requested';
  const refused = await run({ query: [] });
  assert.equal(refused.status, 'failed');
  assert.equal(refused.ok, false);
  assert.match(refused.error, /GMAIL_QUERY_REQUIRED/);
  assert.equal(refused.run_id, undefined, 'invalid query admission must not spawn a trajectory');

  report.browser_flow = 'requested';
  const result = await run({ query: values.query });
  assert.equal(result.status, 'finished');
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.exitCode, 0);
  const rows = listedRows(result.stdout_tail || '');
  assert.ok(rows.some(row => row.subject === values['expected-subject']
    && row.snippet?.includes(values['expected-snippet'])),
  'the real Gmail result list must contain the independently known fixture message, not an echoed query');
  report.observed_rows = rows;
  report.browser_flow = 'passed';
  report.status = 'passed';
} catch (error) {
  report.status = prerequisites ? 'failed' : 'blocked';
  report.error = { name: error.name, message: error.message, stack: error.stack };
  process.exitCode = 1;
} finally {
  await evidence.finish();
}
