import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../../dist/session/wsession.js';
import { CREDENTIAL_FIELD_ABSENT } from '../../../dist/session/wsession-helpers/finalize.js';
import { execute, AgentFailure } from '../../../dist/agent/index.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { writeWelesTrajectoryDraft } from '../../../dist/trajectories/writer.js';
import { envString, normalizedReplay, parseJsonEnv, requireHttpUrl, safeStringMap } from './browser_task/inputs.mjs';
import { identityInstructions, identityPlatformFromConstraints, sessionPlatformFromConstraints } from './browser_task/identity.mjs';
import { ensureFigmaSession, ensureSupabaseSession } from './browser_task/sso_sessions.mjs';
import { captureRequiredBrowserEvidence } from './browser_task/evidence.mjs';

const label = process.env.GENERIC_TASK_LABEL || 'generic_browser_task';

function writeJson(name, value) {
  const dir = runRecordingsDir(label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}

async function applyCredentialPrefill(activeSession, taskConstraints) {
  const entries = Array.isArray(taskConstraints.credential_prefill)
    ? taskConstraints.credential_prefill
    : [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('credential_prefill entries must be objects');
    }
    const target = typeof entry.target === 'string' ? entry.target : '';
    const fieldClass = typeof entry.field_class === 'string' ? entry.field_class : '';
    const capability = entry.capability;
    if (!target || !fieldClass || !capability || typeof capability !== 'object' || Array.isArray(capability)) {
      throw new Error('credential_prefill entry is incomplete');
    }
    // A field that is not on this page leaves its capability unspent, for the
    // agent to fill when the flow reaches it. Said out loud: the alternative
    // reading of a quiet skip is that the credential was refused.
    const outcome = await activeSession.fillCredential(target, fieldClass, capability);
    if (outcome === CREDENTIAL_FIELD_ABSENT) {
      console.log(`[generic] prefill deferred: no ${fieldClass} field on this page; its capability is unspent`);
    }
  }
}

const url = requireHttpUrl(envString('GENERIC_TASK_URL'));
const objective = envString('GENERIC_TASK_OBJECTIVE');
if (!objective.trim()) throw new Error('GENERIC_TASK_OBJECTIVE is required');

const constraints = parseJsonEnv('GENERIC_TASK_CONSTRAINTS', {});
const browserEvidencePolicy = parseJsonEnv('WELES_BROWSER_EVIDENCE_POLICY_JSON', null);
const browserEvidencePolicyActive = envString('WELES_BROWSER_EVIDENCE_POLICY') === 'spis-browser-evidence.1';
if (browserEvidencePolicyActive && (!browserEvidencePolicy || browserEvidencePolicy.version !== 'spis-browser-evidence.1')) {
  throw new Error('Spis browser-evidence policy document is missing or inconsistent');
}
const storesCredentialInSkarbiec = constraints.store_secret_target === 'skarbiec';
if (storesCredentialInSkarbiec) {
  process.env.WELES_SECURE_CREDENTIAL_TASK = '1';
  process.env.WELES_NO_INSTRUMENT = '1';
  process.env.WELES_DISABLE_RECORDING = '1';
  process.env.WELES_PAGE_DIAGNOSTICS = '0';
}
if (browserEvidencePolicyActive && storesCredentialInSkarbiec) {
  throw new Error('Spis browser-evidence tasks cannot acquire or store credentials');
}
const envHints = safeStringMap(parseJsonEnv('GENERIC_TASK_ENV', {}));
for (const [key, value] of Object.entries(envHints)) process.env[key] = value;

const flowName = envString('GENERIC_TASK_FLOW_NAME') || `generic:${new URL(url).hostname}:${objective.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;
const proxy = envString('GENERIC_TASK_PROXY', process.env.PROXY_URL_OVERRIDE || 'none');
const headless = envString('GENERIC_TASK_HEADLESS') === '1';
const browser = envString('GENERIC_TASK_BROWSER', 'chromium');
const os = envString('GENERIC_TASK_OS', 'macos');
const locale = envString('GENERIC_TASK_LOCALE') || undefined;
const keeperFirst = envString('GENERIC_TASK_KEEPER_FIRST') === '1';
const replay = normalizedReplay(parseJsonEnv('GENERIC_TASK_REPLAY', null));
const replayOnly = envString('GENERIC_TASK_REPLAY_ONLY') === '1';
const skipSavedFlowReplay = keeperFirst || envString('GENERIC_TASK_SKIP_SAVED_FLOW_REPLAY') === '1' || !!replay;

/** The draft the agent starts from: a saved replay, a keeper-first discovery, or a written draft. */
async function initialDraft() {
  if (replay) {
    return {
      source: 'saved-replay',
      guidance: 'Replay-only validation mode: execute the persisted trajectory steps from the database. Do not ask the model to invent replacement steps if replay fails.',
      steps: replay,
    };
  }
  if (keeperFirst) {
    return {
      source: 'keeper-first',
      guidance: storesCredentialInSkarbiec
        ? 'Keeper-first discovery mode: complete the live browser flow. Credential material must be finalized only through store_credential; a stored confirmation saves the executed action history as the trajectory.'
        : 'Keeper-first discovery mode: complete the live browser flow before creating a reusable trajectory. A successful done(value) saves the executed action history as the trajectory.',
      steps: [],
    };
  }
  return writeWelesTrajectoryDraft({ objective });
}

/** The goal text handed to the agent. */
function goalFor(trajectoryDraft) {
  return [
    objective,
    '',
    ...identityInstructions(identityPlatformFromConstraints(constraints)),
    '',
    trajectoryDraft.guidance,
    '',
    'Initial URL: ' + url,
    'Constraints: ' + JSON.stringify(constraints),
    ...(browserEvidencePolicyActive ? [
      'The Weles service enforces the attached browser-evidence policy before every interactive tool and inside page permission APIs. Treat policy_withheld results as retained evidence and continue only with non-interactive observation.',
      'Browser-evidence policy: ' + JSON.stringify(browserEvidencePolicy),
    ] : []),
    'Do not make purchases, submit payments, delete data, or perform irreversible/destructive actions.',
    storesCredentialInSkarbiec
      ? 'Do not call done with extracted credential data. Finish only after store_credential has confirmed encrypted storage; return only its non-secret receipt.'
      : 'When finished, call done(value) with a concise JSON-serializable summary and any extracted data.',
  ].join('\n');
}

function draftSummary(trajectoryDraft) {
  return trajectoryDraft ? { source: trajectoryDraft.source, model: trajectoryDraft.model, steps: trajectoryDraft.steps, error: trajectoryDraft.error } : null;
}

let session = null;
let result = null;
let trajectoryDraft = null;
try {
  console.log(`[generic] url=${url} flow=${flowName} browser=${browser} mode=${keeperFirst ? 'keeper_first' : replay ? 'saved_replay' : 'draft_first'}`);
  trajectoryDraft = await initialDraft();
  session = await WSession.start({ label, proxy, targetHost: new URL(url).hostname, headless, browser, os, locale, platform: sessionPlatformFromConstraints(constraints) || undefined, pageDiagnostics: keeperFirst ? false : undefined });
  await session.goto(url);
  await applyCredentialPrefill(session, constraints);
  await ensureSupabaseSession(session, constraints);
  await ensureFigmaSession(session, constraints);
  result = await execute(session, goalFor(trajectoryDraft), {
    envHints,
    flowName,
    replay,
    replayOnly,
    skipSavedFlowReplay,
    disableFlowPersistence: browserEvidencePolicyActive,
    disableArtifacts: browserEvidencePolicyActive,
  });
  if (browserEvidencePolicyActive) await captureRequiredBrowserEvidence(session);
  const payload = browserEvidencePolicyActive ? {
    ok: true,
    url,
    final_url: session.page.url?.() ?? null,
    step_count: result.history.length,
    completed_at: new Date().toISOString(),
  } : {
    ok: true,
    url,
    final_url: session.page.url?.() ?? null,
    value: result.value ?? null,
    trajectory_draft: draftSummary(trajectoryDraft),
    completed_at: new Date().toISOString(),
  };
  writeJson('generic_task_result.json', payload);
  writeJson('ban_signal.json', {
    action: label,
    healthy: true,
    signal: 'healthy',
    details: { final_url: payload.final_url, steps: result.history.length },
    ts: new Date().toISOString(),
  });
  console.log(`PASS: ${label}`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const history = error instanceof AgentFailure ? error.history : result?.history ?? [];
  const finalUrl = session?.page?.url?.() ?? null;
  const needsHumanApproval = /needs_human_approval/i.test(message) || history.some((step) => /needs_human_approval/i.test(String(step?.args?.reason ?? '')));
  writeJson('generic_task_result.json', browserEvidencePolicyActive ? {
    ok: false,
    url,
    final_url: finalUrl,
    error: message.slice(0, 1_000),
    history_steps: history.length,
    completed_at: new Date().toISOString(),
  } : {
    ok: false,
    url,
    final_url: finalUrl,
    error: message,
    history,
    trajectory_draft: draftSummary(trajectoryDraft),
    completed_at: new Date().toISOString(),
  });
  writeJson('ban_signal.json', {
    action: label,
    healthy: false,
    signal: 'task_failed',
    details: { final_url: finalUrl, error: message.slice(0, 1_000), steps: history.length },
    ts: new Date().toISOString(),
  });
  if (needsHumanApproval) {
    writeJson('pending_review.json', {
      status: 'needs_human_approval',
      reason: message.slice(0, 1_000),
      final_url: finalUrl,
      history_steps: history.length,
      completed_at: new Date().toISOString(),
    });
  }
  console.log('FAIL:', message.slice(0, 300));
  process.exitCode = needsHumanApproval ? 0 : 1;
} finally {
  if (session) await session.close();
}

process.exit(process.exitCode ?? 0);
