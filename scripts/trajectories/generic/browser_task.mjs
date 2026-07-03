import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../../dist/session/wsession.js';
import { execute, AgentFailure } from '../../../dist/agent/index.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { writeWelesTrajectoryDraft } from '../../../dist/trajectories/writer.js';

const label = process.env.GENERIC_TASK_LABEL || 'generic_browser_task';

function envString(name, fallback = '') {
  const value = process.env[name];
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

function parseJsonEnv(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

function requireHttpUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('GENERIC_TASK_URL must be a valid URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('GENERIC_TASK_URL must be http(s)');
  return parsed.toString();
}

function writeJson(name, value) {
  const dir = runRecordingsDir(label);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
}

function safeStringMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) continue;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw);
  }
  return out;
}

function normalizedReplay(value) {
  if (!Array.isArray(value)) return null;
  const steps = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const tool = typeof raw.tool === 'string' ? raw.tool : '';
    if (!tool) continue;
    const args = raw.args && typeof raw.args === 'object' && !Array.isArray(raw.args) ? raw.args : {};
    const step = { tool, args };
    if (typeof raw.result === 'string') step.result = raw.result;
    steps.push(step);
  }
  return steps.length > 0 ? steps : null;
}

function identityPlatformFromConstraints(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const secret = String(value.secret || '').toLowerCase();
  if (secret === 'semantic_scholar.api_key') return 'semantic_scholar';
  return '';
}

function identityInstructions(platform) {
  if (!platform) return [];
  const prefix = platform.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const instructions = [
    `Weles generated a registration email identity through its domain rotator / Resend inbox for this run.`,
    `Use these placeholders when a form asks for identity fields: $${prefix}_NEW_FIRSTNAME, $${prefix}_NEW_LASTNAME, $${prefix}_NEW_USERNAME, $${prefix}_NEW_EMAIL, $${prefix}_NEW_PASSWORD. The fill/type tools resolve placeholders before typing; do not type literal placeholder text.`,
    `On Semantic Scholar's API page, fill and submit the HubSpot form embedded in the Request an API Key / api-key-form iframe; do not use the footer newsletter form.`,
    `If the site sends an email confirmation or API-key delivery email, call check_email("$${prefix}_NEW_EMAIL", "") and use the returned code/link/instructions.`,
  ];
  if (platform === 'semantic_scholar') {
    instructions.push(
      'Semantic Scholar API-key iframe exact field plan: fill firstname, lastname, email, company, 0-2/website, country_choice, message, api_endpoints, and api_requests_per_second; choose the Public application radio (input[name="application"]); tick every API acknowledgement/terms checkbox, especially input[name="api_successful_unauth_requests"]; if CAPTCHA/Turnstile/reCAPTCHA appears, call solve_captcha before giving up; then click Submit inside that same iframe. If validation errors remain, repair those exact fields before retrying submit.',
    );
  }
  return instructions;
}


const url = requireHttpUrl(envString('GENERIC_TASK_URL'));
const objective = envString('GENERIC_TASK_OBJECTIVE');
if (!objective.trim()) throw new Error('GENERIC_TASK_OBJECTIVE is required');

const constraints = parseJsonEnv('GENERIC_TASK_CONSTRAINTS', {});
const envHints = safeStringMap(parseJsonEnv('GENERIC_TASK_ENV', {}));
for (const [key, value] of Object.entries(envHints)) process.env[key] = value;

const flowName = envString('GENERIC_TASK_FLOW_NAME') || `generic:${new URL(url).hostname}:${objective.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`;
const proxy = envString('GENERIC_TASK_PROXY', process.env.PROXY_URL_OVERRIDE || 'none');
const headless = envString('GENERIC_TASK_HEADLESS') === '1';
const browser = envString('GENERIC_TASK_BROWSER', 'chromium');
const keeperFirst = envString('GENERIC_TASK_KEEPER_FIRST') === '1';
const replay = normalizedReplay(parseJsonEnv('GENERIC_TASK_REPLAY', null));
const replayOnly = envString('GENERIC_TASK_REPLAY_ONLY') === '1';
const skipSavedFlowReplay = keeperFirst || envString('GENERIC_TASK_SKIP_SAVED_FLOW_REPLAY') === '1' || !!replay;

let session = null;
let result = null;
let trajectoryDraft = null;
try {
  console.log(`[generic] url=${url} flow=${flowName} browser=${browser} mode=${keeperFirst ? 'keeper_first' : replay ? 'saved_replay' : 'draft_first'}`);
  trajectoryDraft = replay
    ? {
      source: 'saved-replay',
      guidance: 'Replay-only validation mode: execute the persisted trajectory steps from the database. Do not ask the model to invent replacement steps if replay fails.',
      steps: replay,
    }
    : keeperFirst
      ? {
        source: 'keeper-first',
        guidance: 'Keeper-first discovery mode: complete the live browser flow before creating a reusable trajectory. A successful done(value) saves the executed action history as the trajectory.',
        steps: [],
      }
      : await writeWelesTrajectoryDraft({ objective });
  session = await WSession.start({ label, proxy, targetHost: new URL(url).hostname, headless, browser, platform: identityPlatformFromConstraints(constraints) || undefined, pageDiagnostics: keeperFirst ? false : undefined });
  await session.goto(url);
  const goal = [
    objective,
    '',
    ...identityInstructions(identityPlatformFromConstraints(constraints)),
    '',
    trajectoryDraft.guidance,
    '',
    'Initial URL: ' + url,
    'Constraints: ' + JSON.stringify(constraints),
    'Do not make purchases, submit payments, delete data, or perform irreversible/destructive actions.',
    'When finished, call done(value) with a concise JSON-serializable summary and any extracted data.',
  ].join('\n');
  result = await execute(session, goal, { envHints, flowName, replay, replayOnly, skipSavedFlowReplay });
  const payload = {
    ok: true,
    url,
    final_url: session.page.url?.() ?? null,
    value: result.value ?? null,
    history: result.history,
    trajectory_draft: trajectoryDraft ? { source: trajectoryDraft.source, model: trajectoryDraft.model, steps: trajectoryDraft.steps, error: trajectoryDraft.error } : null,
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
  writeJson('generic_task_result.json', {
    ok: false,
    url,
    final_url: finalUrl,
    error: message,
    history,
    trajectory_draft: trajectoryDraft ? { source: trajectoryDraft.source, model: trajectoryDraft.model, steps: trajectoryDraft.steps, error: trajectoryDraft.error } : null,
    completed_at: new Date().toISOString(),
  });
  writeJson('ban_signal.json', {
    action: label,
    healthy: false,
    signal: 'task_failed',
    details: { final_url: finalUrl, error: message, steps: history.length },
    ts: new Date().toISOString(),
  });
  if (needsHumanApproval) {
    writeJson('pending_review.json', {
      status: 'needs_human_approval',
      reason: message,
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
