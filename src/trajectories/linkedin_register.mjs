/**
 * LinkedIn signup on dedicated ISP proxies.
 *
 * This trajectory does not attempt to solve or bypass CAPTCHA/checkpoint
 * challenges. It records those states as detection failures so operators do
 * not get false PASS signals from blocked registrations.
 *
 * The run itself lives here: session start, proxy validation, the walk to the
 * signup form, and the ban signal written at the end. The steps it is made of
 * live in ./linkedin_register/.
 */
import { WSession } from '../../dist/session/wsession.js';
import { humanIdlePause } from '../../dist/human/mouse.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { handleCreateAccountChallenge } from './_shared/linkedin/create_account_challenge.mjs';
import { assertLinkedinDedicatedIspProxy, assertLinkedinProxyStable, assertLinkedinRegisterProxyRequest, assertNoLinkedinChallengePage, classifyLinkedinRegisterFailure, getLinkedinFailureDiagnostics, linkedinRegisterExitCode } from './_shared/linkedin/register_guard.mjs';
import { runRecordingsDir } from '../../dist/session/run-recordings.js';
import { HEADLESS, STOP_AFTER_SIGNUP_READY, earlyFingerprintCheck, guestPrewarmUrls, registerBrowser, registerOs, registerPersona, replayWarmProfile, requestedEntryUrl, requestedProxy, safeRequestedProxy, sessionProxy, warmManifest, warmProfileDir } from './linkedin_register/run_request.mjs';
import { enterLinkedinSignup, prewarmLinkedinGuestSession } from './linkedin_register/signup_entry.mjs';
import { hashValue, writeSubmitDiagnostics } from './linkedin_register/diagnostics.mjs';
import { linkedinFailureReasons, loadProxyPreflightSummary } from './linkedin_register/refusal.mjs';
import { createLinkedinAccount } from './linkedin_register/account_creation.mjs';

const stageEvents = [];
function proxyStageState() {
  const cfg = s?.proxyConfig ?? {};
  return {
    expected_exit_ip: proxyWatch.expectedExitIp || '',
    actual_exit_ip: cfg.exit_ip ?? '',
    proxy_type: cfg.proxy_type ?? '',
    provider: cfg.provider ?? '',
    country: cfg.country ?? '',
    platform: cfg.platform ?? '',
  };
}

function recordStage(stage, data = {}) {
  stageEvents.push({
    ts: new Date().toISOString(),
    stage,
    url: s?.page?.url?.() ?? '',
    ...proxyStageState(),
    ...data,
  });
}

console.log(`[register] proxy request: ${safeRequestedProxy(requestedProxy)}`);
console.log(`[register] entry url: ${requestedEntryUrl}`);
if (guestPrewarmUrls.length) console.log(`[register] guest prewarm urls: ${guestPrewarmUrls.length}`);
if (warmProfileDir) console.log(`[register] warm profile dir: ${warmProfileDir}`);
if (warmManifest) console.log('[register] warm manifest loaded: persona+proxy replay enabled');
let s = null;
let id = { first: '', last: '', handle: '', email: '', password: '' };
// The exit IP every later proxy check is measured against. Held in one place so
// the stage log and the account-creation steps always read the same value.
const proxyWatch = { expectedExitIp: '' };
let authState = null;

try {
main: {
  recordStage('proxy_request_received', { requested_proxy: safeRequestedProxy(requestedProxy) });
  assertLinkedinRegisterProxyRequest(requestedProxy);
  recordStage('proxy_request_validated', { requested_proxy: safeRequestedProxy(requestedProxy) });
  s = await WSession.start({
    label: 'linkedin_register',
    proxy: sessionProxy,
    targetHost: 'www.linkedin.com',
    platform: 'linkedin',
    browser: registerBrowser,
    os: registerOs,
    persona: registerPersona,
    headless: HEADLESS,
    userDataDir: warmProfileDir || undefined,
  });
  await replayWarmProfile(s);
  recordStage('session_started');
  await earlyFingerprintCheck(s);
  recordStage('early_fingerprint_ok');
  id = { first: s.identity.firstName, last: s.identity.lastName, handle: s.identity.username, email: s.identity.email, password: s.identity.password };
  proxyWatch.expectedExitIp = s.proxyConfig?.exit_ip ?? '';
  recordStage('identity_ready', { identity_created: true, email_hash: hashValue(id.email), handle_hash: hashValue(id.handle) });
  console.log(`[register] identity generated email_hash=${hashValue(id.email)} handle_hash=${hashValue(id.handle)}`);
  assertLinkedinDedicatedIspProxy(s, requestedProxy);
  recordStage('proxy_metadata_validated');
  const prewarmDiagnostics = await prewarmLinkedinGuestSession(s, guestPrewarmUrls);
  if (prewarmDiagnostics) recordStage('guest_prewarm_complete', { urls: guestPrewarmUrls.length });
  await enterLinkedinSignup(s, requestedEntryUrl);
  recordStage('signup_goto_complete', { entry_url: requestedEntryUrl });
  if (STOP_AFTER_SIGNUP_READY) {
    await writeSubmitDiagnostics('entry_path_stop_after_signup_ready', { url: s.page.url(), entry_url: requestedEntryUrl });
    console.log('[register] LINKEDIN_REGISTER_STOP_AFTER_SIGNUP_READY reached');
    process.exitCode = 0;
    break main;
  }
  await humanIdlePause('deliberate');
  proxyWatch.expectedExitIp = await assertLinkedinProxyStable(s, 'after_goto', proxyWatch.expectedExitIp);
  recordStage('proxy_stable_after_goto');
  await assertNoLinkedinChallengePage(s, 'after_goto');
  recordStage('no_challenge_after_goto');
  authState = await createLinkedinAccount({ session: s, identity: id, recordStage, proxyWatch });
  recordStage('pass');
  console.log(`PASS: ${id.handle}`);
  const diagnostics = await getLinkedinFailureDiagnostics(s, requestedProxy, proxyWatch.expectedExitIp);
  try { mkdirSync(runRecordingsDir('linkedin_register'), { recursive: true }); writeFileSync(join(runRecordingsDir('linkedin_register'), 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: 'healthy', healthy: true, details: { username_hash: hashValue(id.handle), email_hash: hashValue(id.email), final_url: s.page.url(), auth: authState, diagnostics, failure_reasons: [], stage_events: stageEvents }, ts: new Date().toISOString() }, null, 2)); } catch {}
}
} catch (e) {
  const finalUrl = s?.page?.url?.() ?? '';
  const errorMessage = e.message ?? '';
  const sig = classifyLinkedinRegisterFailure(errorMessage, finalUrl);
  recordStage('failure_classified', { signal: sig, error: errorMessage.slice(0, 200) });
  const proxyPreflight = loadProxyPreflightSummary();
  let diagnostics = { proxy: { requested: safeRequestedProxy(requestedProxy), preflight: proxyPreflight } };
  if (s) {
    try {
      diagnostics = await getLinkedinFailureDiagnostics(s, requestedProxy, proxyWatch.expectedExitIp);
    } catch (diagnosticsError) {
      diagnostics = { collected: false, reason: `failure diagnostics could not be read off the live session: ${String(diagnosticsError?.message ?? diagnosticsError).slice(0, 200)}` };
    }
  }
  const failureReasons = linkedinFailureReasons(sig, errorMessage, finalUrl, diagnostics);
  try { mkdirSync(runRecordingsDir('linkedin_register'), { recursive: true }); writeFileSync(join(runRecordingsDir('linkedin_register'), 'ban_signal.json'), JSON.stringify({ action: 'linkedin_register', signal: sig, healthy: false, details: { final_url: finalUrl, error: errorMessage.slice(0, 200), attempted_email_hash: hashValue(id.email), expected_exit_ip: proxyWatch.expectedExitIp, diagnostics, failure_reasons: failureReasons, stage_events: stageEvents }, ts: new Date().toISOString() }, null, 2)); } catch {}
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  // exitCode (not exit) so the finally block's await s.close() actually runs.
  // process.exit(1) kills pending async ops immediately, which prevents
  // Playwright from flushing the recordVideo .webm to disk.
  process.exitCode = linkedinRegisterExitCode(sig);
} finally {
  await s?.close?.();
}
