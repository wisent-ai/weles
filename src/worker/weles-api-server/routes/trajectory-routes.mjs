// The three routes that order one named trajectory rather than one the caller
// names itself.
//
// POST /run takes an action and its parameters and is elsewhere. These three
// each decide the action on the caller's behalf, and each has its own idea of
// who may ask. /imports does not run anything at all: it validates a trajectory
// document and persists it against a host, so a draft becomes an action /run
// can later name. /reauth is admitted by Brama's own token and never by the
// general API token, because it spends a real browser sign-in on exactly one
// vault row and the broker -- not the operator -- decides which. /weles-builder
// takes prose instead of parameters and its answer is a new reusable
// trajectory, so its body is text and not a JSON envelope.
//
// They sit together because they share one refusal: a request that names an
// account it is not entitled to, or a provider Weles does not run on the host,
// is answered before any child is spawned.

import {
  ALLOW_RAW_CREDS,
  ALLOW_UNAUTH,
  BRAMA_REAUTH_TOKEN,
  IMPORT_BODY_LIMIT,
  TIMEOUT_MS,
  TOKEN,
} from '../configuration.mjs';
import {
  authorized,
  json,
  readBody,
  readText,
  reauthAuthorized,
  requireTokenAuthorization,
} from '../http-exchange.mjs';
import { coalesceRun, runAdmissionKey } from '../run/run-outcome.mjs';
import { REAUTH_PROVIDERS, runReauth } from '../run/trajectory-process.mjs';

const BUILDER_BOOTSTRAP_URL = process.env.WELES_BUILDER_BOOTSTRAP_URL || 'https://duckduckgo.com/';
// Prepended to the caller's instructions so the agent self-navigates: the
// caller supplies NO url, only the goal. The agent lands on a neutral
// bootstrap page and drives itself to whatever site the task implies.
const BUILDER_PREAMBLE = [
  'You are given a task in natural language. You start on a neutral bootstrap page.',
  'FIRST decide which website accomplishes the task and go there yourself with the navigate tool; if you do not know the exact URL, search from the current page.',
  'If the task needs an account, call generate_identity(platform) and use the $PLATFORM_NEW_* placeholders in fill/type_text; do not type literal placeholder text.',
  'If the site emails a confirmation code, call check_email. Solve CAPTCHAs with solve_captcha.',
  'Do not make purchases, submit payments, delete data, or perform irreversible/destructive actions.',
  'When finished, call done(value) with a concise JSON-serializable summary plus any data or credentials the task asked for.',
].join(' ');

export async function respondToDocumentImport(req, res, importWelesTrajectoryDocument) {
  if (!requireTokenAuthorization(req, res)) return;
  let body;
  try { body = await readBody(req, IMPORT_BODY_LIMIT); }
  catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
  try {
    const report = await importWelesTrajectoryDocument(body.source, body.target_host);
    json(res, report.imported > 0 ? 201 : 200, report);
  } catch (e) {
    json(res, 400, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) });
  }
}

// Resolve a Skarbiec subscription first; /reauth/resolve never starts a browser.
export async function respondToReauth(req, res, selectLoginAccount, resolveOnly = false) {
  if (!reauthAuthorized(req)) {
    json(res, BRAMA_REAUTH_TOKEN ? 401 : 500, {
      ok: false,
      error: BRAMA_REAUTH_TOKEN ? 'unauthorized' : 'missing_BRAMA_WELES_REAUTH_TOKEN',
    });
    return;
  }
  let body;
  try { body = await readBody(req); }
  catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
  const provider = typeof body.provider === 'string' ? body.provider.trim().toLowerCase() : '';
  if (!REAUTH_PROVIDERS.has(provider)) { json(res, 400, { ok: false, error: 'provider must be codex|claude|kimi' }); return; }
  const subscriptionId = typeof body.subscription_id === 'string' ? body.subscription_id.trim() : '';
  if (!subscriptionId) {
    json(res, 400, { ok: false, error: 'subscription_id_required', stage: 'identity',
      message: 'An exact Skarbiec subscription id is required' });
    return;
  }
  const loginItem = typeof body.login_item === 'string' ? body.login_item.trim() : '';
  let account;
  try { account = selectLoginAccount(provider, loginItem || undefined, subscriptionId); }
  catch (e) {
    json(res, 409, { ok: false, error: e.code || 'skarbiec_identity_unavailable',
      stage: 'identity', message: e.message, ...(e.detail || {}) });
    return;
  }
  const identity = {
    subscription_id: account.subscriptionId,
    subscription_item: account.subscriptionItem,
    login_item: account.loginItem,
    provider: account.provider,
    account_ref: account.accountRef,
    login_method: account.loginMethod,
    source_revision: account.sourceRevision,
  };
  if (resolveOnly) { json(res, 200, { ok: true, source: 'skarbiec', ...identity }); return; }
  if (body.source_revision && body.source_revision !== account.sourceRevision) {
    json(res, 409, { ok: false, error: 'skarbiec_identity_changed', stage: 'identity',
      message: 'Skarbiec account data changed after authentication was resolved', ...identity });
    return;
  }
  const timeoutMs = Number(body.timeout_ms) > 0 ? Number(body.timeout_ms) : TIMEOUT_MS;
  const admission = coalesceRun(
    runAdmissionKey('reauth', {
      provider,
      login_item: account.loginItem,
      subscription_id: account.subscriptionId,
      source_revision: account.sourceRevision,
    }),
    () => runReauth(provider, timeoutMs, account),
  );
  const out = await admission.entry.promise;
  if (out.error === 'no_reauth_trajectory') { json(res, 404, out); return; }
  json(res, out.ok ? 200 : 502, { ...out, ...identity, refreshed: out.ok, coalesced: admission.joined });
}

// weles-builder: instructions-only. Body = the goal string (text/plain;
// {"instructions": "..."} JSON also accepted). No url, no params. The agent
// self-navigates and, on success, its executed steps are saved as a new
// reusable trajectory (generic browser_task draft-first behavior).
export async function respondToBuilder(req, res, runTrajectory) {
  if (!authorized(req)) {
    json(res, TOKEN || ALLOW_UNAUTH ? 401 : 500, { ok: false, error: TOKEN || ALLOW_UNAUTH ? 'unauthorized' : 'missing_WELES_API_TOKEN' });
    return;
  }
  let raw;
  try { raw = await readText(req); }
  catch (e) { json(res, 400, { ok: false, error: e.message }); return; }
  let instructions = (raw || '').trim();
  if (instructions.startsWith('{')) {
    try { const j = JSON.parse(instructions); if (typeof j.instructions === 'string') instructions = j.instructions.trim(); } catch { /* treat as raw text */ }
  }
  if (!instructions) { json(res, 400, { ok: false, error: 'missing_instructions' }); return; }
  const objective = `${BUILDER_PREAMBLE}\n\nTASK:\n${instructions}`;
  const out = await runTrajectory('generic_browser_task', { url: BUILDER_BOOTSTRAP_URL, objective }, null, false, TIMEOUT_MS);
  if (out.error === 'no_trajectory') { json(res, 500, { ok: false, error: 'builder_trajectory_missing' }); return; }
  const doc = out.result && typeof out.result === 'object' ? out.result : {};
  const payload = {
    ok: out.ok,
    run_id: out.run_id,
    exitCode: out.exitCode,
    final_url: doc.final_url ?? null,
    value: doc.value ?? null,
    trajectory_draft: doc.trajectory_draft ?? null,
    stdout_tail: out.stdout_tail,
    stderr_tail: out.stderr_tail,
    timed_out: out.timed_out,
  };
  // Return unredacted by default (the whole point is to get the result/creds
  // the task asked for); redact only when raw creds are globally forbidden.
  json(res, out.ok ? 200 : 502, payload, { redact: !ALLOW_RAW_CREDS });
}
