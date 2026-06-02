/**
 * LinkedIn register landing diagnostic.
 *
 * Opens the signup surface and records page/proxy/challenge/form state. It
 * does not fill fields or submit registration.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../dist/session/wsession.js';
import {
  assertLinkedinDedicatedIspProxy,
  assertLinkedinProxyStable,
  assertLinkedinRegisterProxyRequest,
  ensureLinkedinSignupForm,
  getLinkedinFailureDiagnostics,
  summarizeLinkedinProxyState,
} from './_shared/linkedin/register_guard.mjs';
import { humanIdlePause } from '../../dist/human/mouse.js';

const ACTION = 'linkedin_register_landing_diag';
const URL = 'https://www.linkedin.com/signup';
const requestedProxy = process.env.LINKEDIN_REGISTER_PROXY ?? process.env.LINKEDIN_PROXY ?? process.env.PROXY_URL ?? 'isp decodo us';
const outDir = join(process.cwd(), 'recordings', ACTION);

function safeRequestedProxy(value = '') {
  const raw = String(value ?? '');
  return /^(https?:|socks)/i.test(raw) ? '[url-form]' : raw.slice(0, 80);
}

function writeSignal(signal) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'ban_signal.json'), JSON.stringify({ ...signal, ts: new Date().toISOString() }, null, 2));
}

function reasonFromState({ errorMessage = '', challengeSignal = '', formReady = false, finalUrl = '' }) {
  if (/Executable doesn't exist|browserType\.launch|WELES_FIREFOX_BINARY_NOT_FOUND|playwright install|missing.*browser|Nightly\.app/i.test(errorMessage)) {
    return { code: 'browser_launch_failed', message: errorMessage.slice(0, 240) };
  }
  if (/proxy_unavailable/i.test(errorMessage)) return { code: 'proxy_unavailable', message: errorMessage.slice(0, 240) };
  if (/PROXY_NOT_DEDICATED_ISP/.test(errorMessage)) return { code: 'proxy_not_dedicated_isp', message: errorMessage.slice(0, 240) };
  if (/PROXY_DRIFT_CHECK_FAILED/.test(errorMessage)) return { code: 'proxy_drift_probe_failed', message: errorMessage.slice(0, 240) };
  if (/PROXY_DRIFT:/.test(errorMessage)) return { code: 'proxy_exit_ip_drift', message: errorMessage.slice(0, 240) };
  if (challengeSignal || /captcha|challenge|checkpoint/i.test(`${errorMessage}\n${finalUrl}`)) {
    return { code: 'linkedin_challenge_or_checkpoint', message: challengeSignal || errorMessage.slice(0, 240) || finalUrl.slice(0, 240) };
  }
  if (!formReady || /signup_form_unavailable/.test(errorMessage)) return { code: 'signup_form_unavailable', message: errorMessage.slice(0, 240) || finalUrl.slice(0, 240) };
  return { code: 'landing_diag_failed', message: errorMessage.slice(0, 240) || finalUrl.slice(0, 240) };
}

const stageEvents = [];
let session = null;
let expectedExitIp = '';
let formReady = false;

function recordStage(stage, data = {}) {
  stageEvents.push({
    ts: new Date().toISOString(),
    stage,
    url: session?.page?.url?.() ?? '',
    ...data,
  });
}

try {
  recordStage('proxy_request_received', { requested_proxy: safeRequestedProxy(requestedProxy) });
  assertLinkedinRegisterProxyRequest(requestedProxy);
  recordStage('proxy_request_validated', { requested_proxy: safeRequestedProxy(requestedProxy) });

  session = await WSession.start({ label: ACTION, proxy: requestedProxy, targetHost: 'www.linkedin.com', platform: 'linkedin' });
  recordStage('session_started');

  expectedExitIp = session.proxyConfig?.exit_ip ?? '';
  assertLinkedinDedicatedIspProxy(session, requestedProxy);
  recordStage('proxy_metadata_validated', { proxy: summarizeLinkedinProxyState(session, requestedProxy, expectedExitIp) });

  expectedExitIp = await assertLinkedinProxyStable(session, 'before_signup_landing', expectedExitIp);
  recordStage('proxy_stable_before_signup_landing');

  await session.goto(URL);
  recordStage('signup_goto_complete');
  await humanIdlePause('deliberate');

  expectedExitIp = await assertLinkedinProxyStable(session, 'after_signup_landing', expectedExitIp);
  recordStage('proxy_stable_after_signup_landing');

  const diagnosticsBeforeForm = await getLinkedinFailureDiagnostics(session, requestedProxy, expectedExitIp);
  recordStage('landing_page_summarized', {
    challenge_signal: diagnosticsBeforeForm.challenge_signal ?? '',
    page_key: diagnosticsBeforeForm.page?.pageKey ?? '',
    title: diagnosticsBeforeForm.page?.title ?? '',
  });
  if (diagnosticsBeforeForm.challenge_signal) {
    throw new Error(`DETECTION_TRIGGERED: ${diagnosticsBeforeForm.challenge_signal} final_url=${session.page.url()}`);
  }

  await ensureLinkedinSignupForm(session);
  formReady = true;
  recordStage('signup_form_ready');

  const diagnostics = await getLinkedinFailureDiagnostics(session, requestedProxy, expectedExitIp);
  writeSignal({
    action: ACTION,
    signal: 'healthy',
    healthy: true,
    details: {
      final_url: session.page.url(),
      diagnostics,
      failure_reasons: [],
      stage_events: stageEvents,
    },
  });
  console.log('PASS: linkedin_register_landing_diag');
} catch (e) {
  const errorMessage = e.message ?? '';
  const finalUrl = session?.page?.url?.() ?? '';
  const diagnostics = session ? await getLinkedinFailureDiagnostics(session, requestedProxy, expectedExitIp).catch(() => null) : null;
  recordStage('failure_classified', {
    error: errorMessage.slice(0, 200),
    challenge_signal: diagnostics?.challenge_signal ?? '',
  });
  const reason = reasonFromState({
    errorMessage,
    challengeSignal: diagnostics?.challenge_signal ?? '',
    formReady,
    finalUrl,
  });
  writeSignal({
    action: ACTION,
    signal: reason.code,
    healthy: false,
    details: {
      final_url: finalUrl,
      error: errorMessage.slice(0, 300),
      diagnostics: diagnostics ?? { proxy: { requested: safeRequestedProxy(requestedProxy) } },
      failure_reasons: [reason],
      stage_events: stageEvents,
    },
  });
  console.log(`FAIL: ${errorMessage.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  await session?.close?.();
}
