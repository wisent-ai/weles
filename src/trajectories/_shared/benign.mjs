/**
 * The reviewed observation trajectory. One file reads a declared origin under
 * a declared dwell budget, on any platform that has a ban detector.
 *
 * It used to be reached by thirty public action names — dwell, notifications,
 * search and profile_view on seven sites, plus producthunt_dwell and
 * youtube_dwell — and it carried its own table of origins, scroll counts and
 * dwell ranges, which no caller and no operator could read. The dwell ranges
 * in that table were never even applied: the loop called humanIdlePause()
 * with no argument.
 *
 * Now src/worker/deploy/weles-observation-declaration.json says what a run
 * reads and for how long, admission resolves it before this process exists,
 * and this file spends exactly the budget it was given. Every run writes
 * recordings/<platform>_<verb>/ban_signal.json via the platform's ban
 * detector so the worker can detect silent bans.
 */
import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { detectRedditBanSignals }    from '../../../dist/platforms/reddit/ban_signals.js';
import { detectTwitterBanSignals }   from '../../../dist/platforms/twitter/ban_signals.js';
import { detectInstagramBanSignals } from '../../../dist/platforms/instagram/ban_signals.js';
import { detectTikTokBanSignals }    from '../../../dist/platforms/tiktok/ban_signals.js';
import { detectLinkedInBanSignals }  from '../../../dist/platforms/linkedin/ban_signals.js';
import { detectDiscordBanSignals }   from '../../../dist/platforms/discord/ban_signals.js';
import { detectGitHubBanSignals }    from '../../../dist/platforms/github/ban_signals.js';
import { detectProductHuntBanSignals } from '../../../dist/platforms/producthunt/ban_signals.js';
import { humanIdlePause, humanScroll } from '../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { declaredObservation } from './observation.mjs';

const DETECTORS = {
  reddit: detectRedditBanSignals, twitter: detectTwitterBanSignals,
  instagram: detectInstagramBanSignals, tiktok: detectTikTokBanSignals,
  linkedin: detectLinkedInBanSignals, discord: detectDiscordBanSignals,
  github: detectGitHubBanSignals, producthunt: detectProductHuntBanSignals,
};

const observed = declaredObservation();
const PLATFORM = observed.platform;
const VERB = observed.verb;

const detector = DETECTORS[PLATFORM];
if (!detector) { console.log(`FAIL: no ban detector for ${PLATFORM}`); process.exit(1); }

const label = `${PLATFORM}_${VERB}`;
let acct = null;
let s = null;
let selfHandle = '';
let banSignal = null;
try {
  acct = await getSocialAccount(PLATFORM);
  if (!acct) {
    banSignal = { signal: 'no_account', healthy: false, details: { stage: 'pre-WSession', reason: `no active ${PLATFORM} account` } };
    throw new Error(`no active ${PLATFORM} account`);
  }
  selfHandle = acct.username;
  console.log(`[benign] ${observed.observation} acct=${acct.username} reads=${observed.reads} origin=${observed.origin}`);

  const { proxyUrl, persona } = await resolveAccountSession(acct);
  s = await WSession.start({ label, proxy: proxyUrl, persona });
  await s.goto(observed.origin);
  // The declared dwell budget: `scrolls` bursts, each followed by an idle read
  // inside the declared millisecond range. A budget of zero scrolls still
  // spends one idle read, because a run that navigates and closes at once has
  // not observed anything.
  for (let i = 0; i < observed.scrolls; i++) {
    await humanScroll(s.page, 1200, 3);
    await humanIdlePause(observed.dwellMs);
  }
  if (observed.scrolls === 0) await humanIdlePause(observed.dwellMs);
  banSignal = await detector(s.page, s.capturedResponses).catch(() => null);
  // Reclassify the same way action-runner does — if the page is on the
  // platform's login wall, the ban detector might say healthy or
  // captcha_challenge (PerimeterX iframe loads on every login page) but the
  // real story is cookies-stale. Override to checkpoint so retry pipelines
  // know to refresh the session, not invoke a captcha solver.
  const finalUrl = s.page.url?.() ?? banSignal?.details?.final_url ?? '';
  const bodySample = banSignal?.details?.body_text_sample ?? '';
  const onAuthWall = /\/(login|signin|sessions\/new|uas\/login|checkpoint|accounts\/login)\b/.test(finalUrl) || /\/login\?/.test(finalUrl);
  if (banSignal && onAuthWall && (banSignal.signal === 'healthy' || banSignal.signal === 'captcha_challenge')) {
    banSignal = { signal: 'checkpoint', healthy: false, details: { final_url: finalUrl, reason: `reclassified from ${banSignal.signal} — page on auth wall after benign loop`, prev_signal: banSignal.signal } };
  } else if (banSignal && finalUrl.startsWith('chrome-error://') && (banSignal.signal === 'healthy' || banSignal.signal === 'unknown')) {
    const sig = /HTTP ERROR 407|ERR_PROXY_AUTH/i.test(bodySample) ? 'proxy_auth_failed' : /HTTP ERROR 4|ERR_HTTP_RESPONSE_CODE/i.test(bodySample) ? 'ip_blocked' : 'proxy_failed';
    banSignal = { signal: sig, healthy: false, details: { final_url: finalUrl, reason: `reclassified from ${banSignal.signal} — chrome-error page (body: ${bodySample.slice(0, 80)})`, prev_signal: banSignal.signal } };
  } else if (banSignal && banSignal.signal === 'healthy') {
    // 404 + logged-out shell reclassifier. Per-platform detectors only key
    // off /login URL patterns; a profile-view that 404s on the platform's
    // own 404 page (URL stays on /@username, body contains "404" + a Sign in
    // CTA) sneaks through as healthy. For profile_view of the account's own
    // handle that's a strong signal the account never finalized signup or
    // was silently deleted; for any other verb it's at least cookies-stale.
    const has404 = /\b404\b|page not found|we seem to have lost this page|this page (doesn't|does not) exist/i.test(bodySample);
    const hasLoggedOutCta = /\bsign[\s-]?in\b|\blog[\s-]?in\b/i.test(bodySample);
    if (has404 && hasLoggedOutCta) {
      const sig = VERB === 'profile_view' && finalUrl.toLowerCase().includes(selfHandle.toLowerCase()) ? 'account_missing' : 'checkpoint';
      banSignal = { signal: sig, healthy: false, details: { final_url: finalUrl, reason: `reclassified from healthy — body shows 404 + logged-out CTA (sample: "${bodySample.slice(0, 120)}")`, prev_signal: 'healthy' } };
    }
  }
  console.log(`[ban-signal] ${banSignal?.signal}`);
  console.log(`PASS: ${PLATFORM}_${VERB} ${verbCfg.scrolls}x scrolls`);
} catch (e) {
  if (s) {
    let detResult;
    try { detResult = await detector(s.page, s.capturedResponses); }
    catch (derr) { console.log('[detector] err in catch:', derr?.message?.slice(0, 100)); }
    banSignal = detResult;
    const eFinalUrl = s.page.url?.() ?? banSignal?.details?.final_url ?? '';
    const eBodySample = banSignal?.details?.body_text_sample ?? '';
    const eOnAuthWall = /\/(login|signin|sessions\/new|uas\/login|checkpoint|accounts\/login)\b/.test(eFinalUrl) || /\/login\?/.test(eFinalUrl);
    if (banSignal && eOnAuthWall && (banSignal.signal === 'healthy' || banSignal.signal === 'captcha_challenge')) {
      banSignal = { signal: 'checkpoint', healthy: false, details: { final_url: eFinalUrl, reason: `reclassified from ${banSignal.signal} — page on auth wall after benign loop crash`, prev_signal: banSignal.signal } };
    } else if (banSignal && eFinalUrl.startsWith('chrome-error://') && (banSignal.signal === 'healthy' || banSignal.signal === 'unknown')) {
      const sig = /HTTP ERROR 407|ERR_PROXY_AUTH/i.test(eBodySample) ? 'proxy_auth_failed' : /HTTP ERROR 4|ERR_HTTP_RESPONSE_CODE/i.test(eBodySample) ? 'ip_blocked' : 'proxy_failed';
      banSignal = { signal: sig, healthy: false, details: { final_url: eFinalUrl, reason: `reclassified from ${banSignal.signal} — chrome-error page after benign crash`, prev_signal: banSignal.signal } };
    }
  } else if (!banSignal) {
    // s never opened — getSocialAccount, resolveAccountSession, or WSession.start threw.
    // Classify by exception message so the worker writes a real ban_signal instead of
    // bubbling exit-1 with no diagnostic (the 'unknown_error' baseline on z0earw45dw1p).
    const msg = e?.message?.slice(0, 200) ?? 'unknown';
    const sig = /no_isp_proxy|no isp proxy|no_proxy_resolved/i.test(msg) ? 'no_proxy_resolved' :
                /no active.*account|no_account/i.test(msg) ? 'no_account' :
                /ERR_PROXY_AUTH|HTTP 407/i.test(msg) ? 'proxy_auth_failed' :
                'session_boot_failed';
    banSignal = { signal: sig, healthy: false, details: { stage: 'pre-WSession', reason: msg } };
  }
  if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = runRecordingsDir(label);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct?.id ?? null, username: acct?.username ?? null, action: label, observation: observed.observation, origin: observed.origin, reads: observed.reads, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
    if (banSignal.signal === 'checkpoint' && acct?.id) {
      try { await markCookiesStale(acct.id); }
      catch (mse) { console.log('[mark-stale] err:', mse?.message?.slice(0, 80)); }
    }
  }
  if (s) await s.close();
}
