// Analyze operator-provided text in Pangram's dashboard.
//
// Input precedence:
//   PANGRAM_TEXT > SVC_TEXT > TEXT > PANGRAM_TEXT_FILE > TEXT_FILE > MESSAGE_FILE
//
// Output:
//   recordings/<run>/<action>/pangram_result.json
//   recordings/<run>/<action>/ban_signal.json

import { WSession } from '../../../dist/session/wsession.js';
import { markCookiesStale } from '../../../dist/utils/credentials.js';
import { detectPangramBanSignals } from '../../../dist/platforms/pangram/ban_signals.js';
import { LABEL, RESULT_FILE, dashboardUrl, inputText, mergeResult, textStats, writeJson } from './analyze_text/scan_brief.mjs';
import { authRequiredState, collectResult } from './analyze_text/verdict_reading.mjs';
import { clickAnalyze, dismissCookieBanner, fillInput, readVisibleCreditState } from './analyze_text/dashboard/scan_form.mjs';
import { waitForPublicVerificationIfNeeded } from './analyze_text/dashboard/human_verification.mjs';
import { injectCookies, markAccountExhausted, recordAccountUse, selectPangramAccountForRun } from './analyze_text/account/pool_rotation.mjs';
import { autoRegisterCountToday, autoRegisterPangramAccount, maxAccountAttempts, maxAutoRegisters, readAutoRegisterLedger, registerAfterCreditFailures } from './analyze_text/account/auto_registration.mjs';
import { CookieJarStaleError } from '../_shared/cookie-freshness.mjs';

const text = inputText();
if (!text.trim()) {
  console.log('FAIL: text required via PANGRAM_TEXT, SVC_TEXT, TEXT, PANGRAM_TEXT_FILE, TEXT_FILE, or MESSAGE_FILE');
  process.exit(2);
}

const MIN_WORDS = Number(process.env.PANGRAM_MIN_WORDS || 30);
const MIN_CHARS = Number(process.env.PANGRAM_MIN_CHARS || 200);
const wordCount = text.trim().split(/\s+/).length;
if (text.length < MIN_CHARS || wordCount < MIN_WORDS) {
  console.log(`FAIL: text too short for Pangram scanner (${wordCount} words, ${text.length} chars). Minimum ${MIN_WORDS} words / ${MIN_CHARS} chars. Set PANGRAM_MIN_WORDS/PANGRAM_MIN_CHARS to override.`);
  process.exit(2);
}

process.env.WELES_CAPTURE_RESPONSE_BODIES = process.env.WELES_CAPTURE_RESPONSE_BODIES || '1';

const stats = textStats(text);
const url = dashboardUrl();
let acct = null;
let s = null;
let banSignal = null;
let accountSelection = null;
let accountUsage = null;

const noAccount = process.env.PANGRAM_NO_ACCOUNT === '1';
const maxRunAttempts = noAccount ? 1 : maxAccountAttempts();
let completed = false;

for (let runAttempt = 1; runAttempt <= maxRunAttempts; runAttempt += 1) {
  acct = null;
  s = null;
  banSignal = null;
  accountSelection = null;
  accountUsage = null;
  let shouldRetryAccount = false;

try {
  accountSelection = noAccount ? { account: null, reason: 'no_account_disabled', pool: null } : await selectPangramAccountForRun();
  acct = accountSelection.account;

  if (!acct && process.env.PANGRAM_AUTO_REGISTER === '1' && !noAccount) {
    const autoReason = accountSelection?.reason || 'no_account';
    console.log(`[pangram:analyze_text] auto_register triggered reason=${autoReason}`);
    const registerResult = await autoRegisterPangramAccount(autoReason);
    console.log(`[pangram:analyze_text] auto_register success=${registerResult.success} reason=${registerResult.reason}`);
    if (registerResult.success) {
      accountSelection = await selectPangramAccountForRun();
      acct = accountSelection.account;
    }
  }

  if (!acct && process.env.PANGRAM_REQUIRE_ACCOUNT === '1') {
    const reason = accountSelection?.reason || 'no active pangram account';
    banSignal = {
      signal: reason === 'quota_exhausted' ? 'quota_exhausted' : 'no_account',
      healthy: false,
      details: {
        stage: 'pre-WSession',
        reason,
        account_pool: accountSelection?.pool ?? null,
        auto_register: process.env.PANGRAM_AUTO_REGISTER === '1' ? {
          today_count: autoRegisterCountToday(readAutoRegisterLedger()),
          daily_limit: maxAutoRegisters(),
        } : null,
      },
    };
    throw new Error(reason);
  }

  const sessionOpts = acct ? accountSelection.sessionOpts : {};
  s = await WSession.start({ label: LABEL, proxy: sessionOpts.proxyUrl, persona: sessionOpts.persona, targetHost: new URL(url).hostname, browser: 'chromium', os: process.env.WELES_FORCE_OS || undefined });
  let injectedCookies = 0;
  if (acct) {
    try {
      injectedCookies = await injectCookies(s, acct, sessionOpts, accountSelection.cookies);
      accountUsage = recordAccountUse(acct, stats, accountSelection.pool);
      console.log(`[pangram:analyze_text] account=${acct.username ?? acct.id ?? '?'} usage=${accountUsage?.scan_attempts ?? '?'} limit=${accountUsage?.daily_limit ?? '?'} injected=${injectedCookies}`);
    } catch (jarErr) {
      if (jarErr instanceof CookieJarStaleError) {
        banSignal = { signal: 'checkpoint', healthy: false, details: { reason: jarErr.message.slice(0, 200), ...(jarErr.details ?? {}) } };
        if (acct.id) {
          try {
            await markCookiesStale(acct.id);
          } catch (markError) {
            throw new Error(`pangram cookie jar was rejected: ${jarErr.message}; and the account stayed unmarked: ${markError.message}`, { cause: jarErr });
          }
        }
        throw jarErr;
      }
      throw jarErr;
    }
  }

  console.log(`[pangram:analyze_text] chars=${stats.chars} words=${stats.words} url=${url}`);
  await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 }); // allow-raw-playwright: bounded public page navigation; WSession.goto can stall on screenshots
  console.log('[pangram:analyze_text] after_goto');
  await dismissCookieBanner(s.page);
  console.log('[pangram:analyze_text] after_cookie_1');
  const inputSelector = await fillInput(s.page, text);
  console.log(`[pangram:analyze_text] input=${inputSelector}`);
  await dismissCookieBanner(s.page);
  console.log('[pangram:analyze_text] after_cookie_2');
  const creditState = await readVisibleCreditState(s.page);
  if (acct && creditState && creditState.available <= 0) {
    accountUsage = markAccountExhausted(acct, stats, accountSelection.pool, 'visible_credit_state_zero', creditState);
    banSignal = {
      signal: 'insufficient_credits',
      healthy: false,
      details: {
        final_url: s.page.url(),
        account_id: acct?.id ?? null,
        username: acct?.username ?? null,
        credit_state: creditState,
      },
    };
    throw new Error('pangram_insufficient_credits');
  }
  if (!acct) {
    const verification = await waitForPublicVerificationIfNeeded(s.page);
    console.log(`[pangram:analyze_text] public_verification=${JSON.stringify(verification)}`);
    if (!verification.turnstileFrames && !verification.turnstileContainers && !verification.verifyText && verification.enabledScan) {
      banSignal = {
        signal: 'auth_required',
        healthy: false,
        details: {
          final_url: s.page.url(),
          reason: 'public no-login Scan for AI is enabled only as signup redirect; no Turnstile widget/anonymous-scan path was exposed',
          verification,
        },
      };
      throw new Error('pangram_public_auth_required');
    }
    if ((verification.turnstileFrames || verification.turnstileContainers || verification.verifyText || verification.scanButtons?.length) && !verification.enabledScan) {
      banSignal = {
        signal: (verification.turnstileFrames || verification.turnstileContainers || verification.verifyText) ? 'captcha_required' : 'scan_disabled',
        healthy: false,
        details: {
          final_url: s.page.url(),
          reason: (verification.turnstileFrames || verification.turnstileContainers || verification.verifyText)
            ? 'public no-login checker requires Turnstile token before Scan for AI is enabled'
            : 'public no-login Scan for AI button remained disabled; no result request was sent',
          verification,
        },
      };
      throw new Error(`pangram_public_${banSignal.signal}`);
    }
  }
  const clicked = await clickAnalyze(s.page);
  console.log(`[pangram:analyze_text] clicked=${clicked}`);
  await s.page.waitForLoadState('networkidle');
  const result = await collectResult(s, Number(process.env.PANGRAM_ANALYZE_TIMEOUT_MS || 90_000));
  const finalUrl = s.page.url?.() ?? url;

  banSignal = await detectPangramBanSignals(s.page, s.capturedResponses);
  const authReason = result.source === 'none' ? authRequiredState(finalUrl, result) : null;
  if (authReason) {
    banSignal = { signal: 'auth_required', healthy: false, details: { final_url: finalUrl, reason: authReason, body_text_sample: result.body_text_sample } };
  }
  if (banSignal?.signal === 'healthy' && result.source === 'none') {
    banSignal = { signal: 'unknown_error', healthy: false, details: { final_url: finalUrl, reason: 'pangram_result_not_found', body_text_sample: result.body_text_sample } };
  }
  if (banSignal?.signal === 'healthy') {
    const out = mergeResult({
      action: LABEL,
      final_url: finalUrl,
      input: stats,
      input_selector: inputSelector,
      clicked,
      injected_cookies: injectedCookies,
      captured_response_count: s.capturedResponses.length,
      account_pool: accountSelection?.pool ?? null,
      account_usage: accountUsage,
      ts: new Date().toISOString(),
    }, result);
    writeJson(RESULT_FILE, out);
    console.log(`[pangram-result] ${JSON.stringify({ verdict: out.verdict, ai_percent: out.ai_percent, human_percent: out.human_percent, confidence_percent: out.confidence_percent, source: out.source })}`);
    console.log(`[ban-signal] ${banSignal.signal}`);
    console.log(`PASS: pangram_analyze_text ${out.verdict ?? 'result'} source=${out.source}`);
    completed = true;
  } else {
    console.log(`[ban-signal] ${banSignal?.signal ?? 'unknown_error'}`);
    throw new Error(`pangram_unhealthy:${banSignal?.signal ?? 'unknown_error'}`);
  }
} catch (e) {
  if (s && !banSignal) {
    try {
      banSignal = await detectPangramBanSignals(s.page, s.capturedResponses);
    } catch (signalError) {
      throw new Error(`pangram run failed with ${e.message}; and reading its ban signals failed too: ${signalError.message}`, { cause: e });
    }
  }
  if (!banSignal) banSignal = { signal: 'unknown_error', healthy: false, details: { reason: e.message?.slice(0, 200) ?? 'unknown' } };
  if (banSignal.signal === 'healthy') {
    banSignal = { signal: 'unknown_error', healthy: false, details: { final_url: s?.page?.url?.() ?? '', reason: e.message?.slice(0, 200) ?? 'unknown', prev_signal: 'healthy' } };
  }
  if (banSignal.signal === 'insufficient_credits' && acct) {
    accountUsage = markAccountExhausted(acct, stats, accountSelection?.pool, 'insufficient_credits', banSignal.details?.credit_state ?? null);
  }
  console.log(`[ban-signal] ${banSignal.signal}`);
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  if (!noAccount && banSignal.signal === 'insufficient_credits' && runAttempt < maxRunAttempts) {
    const creditFailureThreshold = registerAfterCreditFailures();
    if (process.env.PANGRAM_AUTO_REGISTER === '1' && runAttempt % creditFailureThreshold === 0) {
      console.log(`[pangram:analyze_text] auto_register triggered reason=insufficient_credits attempts=${runAttempt}/${maxRunAttempts}`);
      const registerResult = await autoRegisterPangramAccount('insufficient_credits');
      console.log(`[pangram:analyze_text] auto_register success=${registerResult.success} reason=${registerResult.reason}`);
    }
    shouldRetryAccount = true;
    console.log(`[pangram:analyze_text] retrying with another account after insufficient_credits attempt=${runAttempt}/${maxRunAttempts}`);
  } else {
    process.exitCode = process.exitCode || 1;
  }
} finally {
  if (banSignal) {
    writeJson('ban_signal.json', {
      account_id: acct?.id ?? null,
      username: acct?.username ?? null,
      account_pool: accountSelection?.pool ?? null,
      account_usage: accountUsage,
      action: LABEL,
      ...banSignal,
      ts: new Date().toISOString(),
    });
  }
  if (banSignal?.signal === 'checkpoint' && acct?.id) {
    await markCookiesStale(acct.id).catch((e) => console.log(`[mark-stale] err: ${e.message?.slice(0, 80)}`));
  }
  if (s) await s.close();
}

  if (completed) break;
  if (shouldRetryAccount) continue;
  break;
}
