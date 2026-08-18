import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../../dist/session/wsession.js';
import { execute, AgentFailure } from '../../../dist/agent/index.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { writeWelesTrajectoryDraft } from '../../../dist/trajectories/writer.js';
import { getGoogleSsoCreds, googleSso } from '../_shared/services/google_sso.mjs';

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
  if (secret === 'brave.search_api_key') return 'brave';
  return '';
}

function sessionPlatformFromConstraints(value) {
  const identityPlatform = identityPlatformFromConstraints(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return identityPlatform;
  const explicit = typeof value.session_platform === 'string'
    ? value.session_platform.trim().toLowerCase()
    : '';
  if (!explicit) return identityPlatform;
  if (!process.env.ACCOUNT_ID?.trim()) {
    throw new Error('constraints.session_platform requires an account-bound task');
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(explicit)) {
    throw new Error('constraints.session_platform is invalid');
  }
  return explicit;
}

function identityInstructions(platform) {
  if (!platform) return [];
  const prefix = platform.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
  const instructions = [
    'Weles generated a registration email identity through its domain rotator / Resend inbox for this run.',
    'Use fill_identity(target, field) for generated email, password, username, first_name, last_name, and birth-date fields. The generated values stay inside WSession and never appear in model tool arguments or results.',
    `If the site sends an email confirmation, call check_email("$${prefix}_NEW_EMAIL", "") and follow the returned code, link, or instructions before attempting to sign in.`,
    'Do not return raw API keys in done(value). Store newly issued token or API-key material only through store_credential.',
  ];
  if (platform === 'semantic_scholar') {
    instructions.push(
      'On Semantic Scholar\'s API page, fill and submit the HubSpot form embedded in the Request an API Key / api-key-form iframe; do not use the footer newsletter form.',
      'Semantic Scholar API-key iframe exact field plan: fill firstname, lastname, email, company, 0-2/website, country_choice, message, api_endpoints, and api_requests_per_second; choose the Public application radio (input[name="application"]); tick every API acknowledgement/terms checkbox, especially input[name="api_successful_unauth_requests"]; if CAPTCHA/Turnstile/reCAPTCHA appears, call solve_captcha before giving up; then click Submit inside that same iframe. If validation errors remain, repair those exact fields before retrying submit. Post-submit key-delivery email is handled by the server-side Semantic Scholar follow-up scanner.',
    );
  }
  if (platform === 'brave') {
    instructions.push(
      'Brave Search exact plan: create one account with the generated Brave identity and fill every required registration field. Call solve_captcha exactly once after the form is valid; Brave uses a proof-of-work Register control, so solve_captcha clicks it, waits for the proof, and automatically submits the form. After solve_captcha succeeds, do not click Register again: wait for the registration response, then check the generated mailbox for Brave verification before trying to log in. Keep using that same identity; never restart registration with invented credentials. After verification, sign in, open the API Keys area, select only a no-payment/free Search API option when required, create one key, and call store_credential on the displayed key.',
    );
  }
  return instructions;
}

async function ensureSupabaseSession(activeSession, taskConstraints) {
  const accountEmail = typeof taskConstraints.account_email === 'string'
    ? taskConstraints.account_email.trim().toLowerCase()
    : '';
  if (taskConstraints.secret !== 'supabase.personal_access_token' || !accountEmail) return;

  const page = activeSession.page;
  await page.waitForLoadState?.('domcontentloaded').catch(() => {});
  if (!/sign-in|accounts\.google\.com/i.test(page.url())) return;
  const credentials = await getGoogleSsoCreds(accountEmail);
  if (!credentials) throw new Error(`Google SSO credentials are unavailable for ${accountEmail}`);

  let authPage = page;
  if (!/accounts\.google\.com/i.test(page.url())) {
    const googleButton = page.getByRole('button', { name: /continue with google|sign in with google/i })
      .or(page.getByRole('link', { name: /continue with google|sign in with google/i }))
      .first();
    if (!await googleButton.isVisible().catch(() => false)) {
      throw new Error('Supabase Google sign-in control is unavailable');
    }
    const popupPromise = page.context().waitForEvent('page', { timeout: 10_000 }).catch(() => null);
    await googleButton.click();
    authPage = await popupPromise
      ?? page.context().pages().find((candidate) => /accounts\.google\.com/i.test(candidate.url()))
      ?? page;
  }
  const signedIn = await googleSso(activeSession, credentials, { page: authPage, originHost: 'supabase.com' });
  if (!signedIn) throw new Error(`Google SSO failed for ${accountEmail}`);
  await page.waitForURL(/supabase\.com\/dashboard/, { timeout: 30_000 }).catch(() => {});
}

async function ensureFigmaSession(activeSession, taskConstraints) {
  if (taskConstraints.secret !== 'figma.personal_access_token') return;

  const accountEmail = typeof taskConstraints.account_email === 'string'
    ? taskConstraints.account_email.trim().toLowerCase()
    : '';
  if (!accountEmail) throw new Error('Figma token acquisition requires an exact account email');

  const page = activeSession.page;
  const context = page.context();
  let recoveryPage = null;
  await page.waitForLoadState?.('domcontentloaded').catch(() => {});
  const googleButton = page.getByRole('button', { name: /continue with google|log in with google|sign in with google/i })
    .or(page.getByRole('link', { name: /continue with google|log in with google|sign in with google/i }))
    .first();
  const requiresSignIn = /\/login(?:[/?#]|$)|accounts\.google\.com/i.test(page.url())
    || await googleButton.isVisible().catch(() => false);
  if (!requiresSignIn) return;

  const credentials = await getGoogleSsoCreds(accountEmail);
  if (!credentials) throw new Error(`Google SSO credentials are unavailable for ${accountEmail}`);
  const keepOAuthPageOpen = () => {
    Object.defineProperty(window, 'close', {
      configurable: false,
      value: () => undefined,
      writable: false,
    });
  };
  await context.addInitScript(keepOAuthPageOpen);
  await page.evaluate(keepOAuthPageOpen).catch(() => {});

  const emailInput = page.locator('input[type="email"], input[name="email"]').filter({ visible: true }).first();
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill(credentials.email);
    const continueButton = page.getByRole('button', { name: /^(continue|log in)$/i })
      .filter({ visible: true })
      .first();
    if (await continueButton.isVisible().catch(() => false)) {
      await continueButton.click();
      const passwordInput = page.locator('input[type="password"], input[name="password"]')
        .filter({ visible: true })
        .first();
      await passwordInput.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});
      if (await passwordInput.isVisible().catch(() => false)) {
        await passwordInput.fill(credentials.password);
        await page.keyboard.press('Enter');
        await page.waitForURL((current) => !/figma\.com\/login(?:[/?#]|$)/i.test(current.href), {
          timeout: 15_000,
        }).catch(() => {});
        if (!/figma\.com\/login(?:[/?#]|$)/i.test(page.url())) {
          console.log('[figma_sso] established Figma session with direct credentials');
          return;
        }
        console.log('[figma_sso] direct credential login did not establish a session; using Google SSO');
      }
    }
  }

  let authPage = page;
  if (!/accounts\.google\.com/i.test(page.url())) {
    recoveryPage = await context.newPage();
    await recoveryPage.goto('about:blank');
    const popupPromise = context.waitForEvent('page', { timeout: 10_000 }).catch(() => null);
    const buttonMetadata = await googleButton.evaluate((element) => ({
      tag: element.tagName,
      href: element instanceof HTMLAnchorElement ? element.href : '',
      target: element instanceof HTMLAnchorElement ? element.target : '',
    })).catch(() => ({ tag: 'unknown', href: '', target: '' }));
    console.log(`[figma_sso] Google control=${JSON.stringify(buttonMetadata)}`);
    let clickError = null;
    await googleButton.click({ noWaitAfter: true }).catch((error) => {
      clickError = error;
    });
    authPage = await popupPromise
      ?? context.pages().find((candidate) => /accounts\.google\.com/i.test(candidate.url()))
      ?? page;
    if (clickError && !/accounts\.google\.com/i.test(authPage.url())) throw clickError;
  }
  const signedIn = await googleSso(activeSession, credentials, { page: authPage, originHost: 'figma.com' });
  if (!signedIn) throw new Error(`Figma Google SSO failed for ${accountEmail}`);
  const availablePages = context.pages();
  const liveFigmaPages = availablePages.filter((candidate) => (
    !candidate.isClosed?.() && /figma\.com/i.test(candidate.url())
  ));
  const liveFigmaPage = liveFigmaPages.find((candidate) => (
    !/figma\.com\/login(?:[/?#]|$)/i.test(candidate.url())
  )) ?? liveFigmaPages[0];
  console.log(`[figma_sso] pages after Google SSO=${JSON.stringify(availablePages.map((candidate) => ({
    closed: candidate.isClosed?.() ?? false,
    url: candidate.url(),
  })))}`);
  const targetPage = page.isClosed?.() ? (liveFigmaPage ?? recoveryPage) : page;
  if (targetPage !== page) activeSession.page = targetPage;
  if (!targetPage || targetPage.isClosed?.()) {
    throw new Error(`Figma closed every recoverable page after Google SSO for ${accountEmail}`);
  }
  await targetPage.waitForURL(/figma\.com\/(files|settings)/, { timeout: 30_000 }).catch(() => {});
  if (/figma\.com\/login(?:[/?#]|$)/i.test(targetPage.url())) {
    await targetPage.goto('https://www.figma.com/settings?tab=security');
    await targetPage.waitForLoadState?.('domcontentloaded').catch(() => {});
  }
  if (/figma\.com\/login(?:[/?#]|$)/i.test(targetPage.url())) {
    throw new Error(`Figma did not establish a session for ${accountEmail}`);
  }
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
    await activeSession.fillCredential(target, fieldClass, capability);
  }
}
const url = requireHttpUrl(envString('GENERIC_TASK_URL'));
const objective = envString('GENERIC_TASK_OBJECTIVE');
if (!objective.trim()) throw new Error('GENERIC_TASK_OBJECTIVE is required');

const constraints = parseJsonEnv('GENERIC_TASK_CONSTRAINTS', {});
const storesCredentialInSkarbiec = constraints.store_secret_target === 'skarbiec';
if (storesCredentialInSkarbiec) {
  process.env.WELES_SECURE_CREDENTIAL_TASK = '1';
  process.env.WELES_NO_INSTRUMENT = '1';
  process.env.WELES_DISABLE_RECORDING = '1';
  process.env.WELES_PAGE_DIAGNOSTICS = '0';
}
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
        guidance: storesCredentialInSkarbiec
          ? 'Keeper-first discovery mode: complete the live browser flow. Credential material must be finalized only through store_credential; a stored confirmation saves the executed action history as the trajectory.'
          : 'Keeper-first discovery mode: complete the live browser flow before creating a reusable trajectory. A successful done(value) saves the executed action history as the trajectory.',
        steps: [],
      }
      : await writeWelesTrajectoryDraft({ objective });
  session = await WSession.start({ label, proxy, targetHost: new URL(url).hostname, headless, browser, platform: sessionPlatformFromConstraints(constraints) || undefined, pageDiagnostics: keeperFirst ? false : undefined });
  await session.goto(url);
  await applyCredentialPrefill(session, constraints);
  await ensureSupabaseSession(session, constraints);
  await ensureFigmaSession(session, constraints);
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
    storesCredentialInSkarbiec
      ? 'Do not call done with extracted credential data. Finish only after store_credential has confirmed encrypted storage; return only its non-secret receipt.'
      : 'When finished, call done(value) with a concise JSON-serializable summary and any extracted data.',
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
