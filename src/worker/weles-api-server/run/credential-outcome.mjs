// What a credential run is, what it failed at, and what it produced.
//
// A login, reauth or register trajectory is not an ordinary run: it prints a
// minted credential to stdout, so the general answer path must never return its
// output verbatim. Recognising one from its action name is therefore the first
// question here, and it decides both how the run is coalesced and how it is
// answered.
//
// The other two are the only two things a caller may learn about such a run.
// Failure is reduced to an allowlisted identifier plus the last declared stage,
// parsed out of stderr, because arbitrary failure text from a browser session
// is exactly where a password ends up. Success is reduced to a row in the
// entitlements-router credential table plus a reference to it, so the raw tuple
// stays inside the process.

import { REPO } from '../release-identity.mjs';

export function isCredentialTrajectory(action) {
  return /(?:^|_)(?:login|reauth|register)$/.test(action);
}

// The one machine record both acquisition readers write
// (src/secrets/scoped-service/acquisition-failure.ts acquisitionRecord and
// src/_shared/scoped-secrets.mjs): nothing is read from the sentence around it.
const ACQUISITION_RECORD =
  /\[skarbiec_acquisition item=([A-Za-z0-9._-]+) field=([A-Za-z0-9._-]+) consumer=([A-Za-z0-9._-]+)(?: reason=([a-z_]+))?\]/;

export function credentialFailure(out) {
  const stderr = String(out.stderr_tail || '');
  const structured = stderr.split('\n').reverse().find((line) => line.startsWith('AUTH_FAILURE '));
  if (structured) {
    try {
      const failure = JSON.parse(structured.slice('AUTH_FAILURE '.length));
      if (typeof failure.code === 'string' && typeof failure.stage === 'string'
          && typeof failure.message === 'string') return failure;
    } catch { /* The malformed marker is not a structured failure. */ }
  }
  const stages = [...stderr.matchAll(/^STEP ([a-z][a-z0-9_-]{0,63})$/gm)];
  const stage = stages.length ? stages[stages.length - 1][1] : undefined;
  const withStage = (failure) => (stage ? { ...failure, stage } : failure);

  if (out.timed_out) return withStage({ code: 'trajectory_timeout' });

  const record = stderr.match(ACQUISITION_RECORD);
  if (record) {
    return withStage({
      code: 'skarbiec_acquisition_failed',
      item: record[1],
      field: record[2],
      consumer: record[3],
      ...(record[4] ? { reason: record[4] } : {}),
    });
  }
  return withStage({ code: 'trajectory_failed' });
}

// Pull a credential tuple out of a trajectory result value. Tolerant of nesting
// (result.value, result.value.credentials, top-level) and common field names.
export function extractCreds(doc) {
  const candidates = [];
  const push = (o) => { if (o && typeof o === 'object' && !Array.isArray(o)) candidates.push(o); };
  push(doc);
  if (doc && typeof doc === 'object') {
    push(doc.value);
    push(doc.credentials);
    push(doc.value && doc.value.credentials);
    push(doc.account);
    push(doc.value && doc.value.account);
  }
  const pick = (o, keys) => { for (const k of keys) { for (const kk of Object.keys(o)) { if (kk.toLowerCase() === k && typeof o[kk] === 'string' && o[kk].trim()) return o[kk].trim(); } } return ''; };
  for (const o of candidates) {
    const email = pick(o, ['email', 'login_email', 'e_mail']);
    const username = pick(o, ['username', 'user', 'handle', 'login']);
    const password = pick(o, ['password', 'login_password', 'pass', 'pwd']);
    if (email || username || password) {
      return { email, username, password, phone: pick(o, ['phone', 'phone_number']) };
    }
  }
  return null;
}

export async function storeCredential(action, params, creds, runId) {
  const { upsertCredential } = await import(`${REPO}/src/lib/service_credentials.mjs`);
  const provider = (typeof params.platform === 'string' && params.platform)
    || action.split('_')[0]
    || 'generic';
  const loginEmail = creds.email || creds.username || '';
  const id = `weles-api-${provider}-${runId.slice(0, 8)}`;
  const row = {
    id,
    category: 'auth',
    display_name: `${provider} account (weles-api ${runId.slice(0, 8)})`,
    login_method: 'email_password',
    login_email: loginEmail,
    login_password: creds.password || '',
    metadata: {
      provider,
      username: creds.username || null,
      phone: creds.phone || null,
      source: 'weles-api',
      source_run_id: runId,
      action,
      created_by: 'weles-api',
      updated_at: new Date().toISOString(),
    },
    updated_at: new Date().toISOString(),
  };
  const rows = await upsertCredential(row);
  const saved = Array.isArray(rows) ? rows[0] : rows;
  return {
    credential_id: (saved && saved.id) || id,
    provider,
    login_email: loginEmail,
    has_password: Boolean(creds.password),
  };
}
