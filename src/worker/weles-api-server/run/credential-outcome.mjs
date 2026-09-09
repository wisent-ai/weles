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

function skarbiecAcquisitionFailureReason(stderr) {
  if (/acquisition field does not exist on item|canonical item has no field:/.test(stderr)) {
    return 'field_not_present';
  }
  if (/undeclared Skarbiec acquisition scope/.test(stderr)) return 'scope_not_declared';
  if (/Skarbiec .* is unreachable|endpoint .* is not listening/.test(stderr)) {
    return 'authority_unreachable';
  }
  if (/\bHTTP 401\b/.test(stderr)) return 'workload_not_authorized';
  return undefined;
}

export function credentialFailure(out) {
  const stderr = String(out.stderr_tail || '');
  const stages = [...stderr.matchAll(/^STEP ([a-z][a-z0-9_-]{0,63})$/gm)];
  const stage = stages.length ? stages[stages.length - 1][1] : undefined;
  const withStage = (failure) => (stage ? { ...failure, stage } : failure);

  if (out.timed_out) return withStage({ code: 'trajectory_timeout' });

  let match = stderr.match(
    /workload-bound Skarbiec acquisition failed for ([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+) as consumer ([A-Za-z0-9._-]+)/,
  );
  if (match) {
    const reason = skarbiecAcquisitionFailureReason(stderr);
    return withStage({
      code: 'skarbiec_acquisition_failed',
      item: match[1],
      field: match[2],
      consumer: match[3],
      ...(reason ? { reason } : {}),
    });
  }

  if (/no login material for '/.test(stderr)) {
    return withStage({ code: 'login_material_unavailable' });
  }
  if (/claude binary not at /.test(stderr)) {
    return withStage({ code: 'claude_binary_missing' });
  }

  match = stderr.match(/needs capability '([A-Za-z0-9._-]+)'/);
  if (match) {
    return withStage({ code: 'capability_unavailable', capability: match[1] });
  }
  if (/loginMethod=.*expected google_sso/.test(stderr)) {
    return withStage({ code: 'login_method_mismatch' });
  }
  if (/authorization code never displayed/.test(stderr)) {
    return withStage({ code: 'authorization_code_unavailable' });
  }
  if (/auth login: .* not seen in /.test(stderr)) {
    return withStage({ code: 'claude_auth_prompt_unavailable' });
  }

  match = stderr.match(/auth login exited early \(code (-?\d+)\)/);
  if (match) {
    return withStage({ code: 'claude_auth_exited_early', exit_code: Number(match[1]) });
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
