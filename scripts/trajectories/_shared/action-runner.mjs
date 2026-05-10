/**
 * Shared action runner. Drives browse / organic_comment / promote across
 * every platform from a per-platform config.
 *
 * Config shape:
 *   platform:       string ('twitter' | 'instagram' | ...)
 *   action:         'browse' | 'organic_comment' | 'promote' | 'post' | 'post_promote'
 *   feedUrl:        string | () => string — landing URL for this action
 *   scrolls:        number — how many idle scrolls for browse
 *   banDetector:    async (page, responses) => BanSignal
 *   submitComment:  async (s, text) => void — deterministic Playwright path for comment/promote
 *   submitPost:     async (s, text) => void — deterministic Playwright path for post/post_promote
 *
 * Reads character + product context from the DB as needed. Writes
 * recordings/<platform>_<action>/ban_signal.json.
 */
import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from './cookie-freshness.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { humanIdlePause } from '../../../dist/human/mouse.js';

// Re-exported assert used by the 27 specialized trajectories (linkedin/like, twitter/follow, instagram/save, github/star, etc) that don't go through runAction. Detects three failure modes that previously fell through to ban_signal:healthy: (1) chrome-error://chromewebdata/ from proxy CONNECT failure; (2) URL on a platform login wall (cookies stale); (3) platform-specific logged-out redirect (twitter/?failedScript, instagram/accounts/login, etc). Throws a typed error with a structured banSignal so the caller's catch can persist it.
const _AUTH_WALL = /\/(login|signin|sessions\/new|uas\/login|checkpoint|accounts\/login)\b/;
// Per-platform logged-out redirect markers. Includes both /login-style URLs AND the bare-root redirect that platforms use when an unauthed session asks for a logged-in path. The bare-root is critical: when an unauthed twitter user goes to x.com/home, the server redirects to plain x.com/, no /login marker — pre-fix the trajectory continued and the ban detector returned 'healthy' on what was clearly a logged-out landing page.
const _LOGGED_OUT_MARKERS = {
  twitter:   /failedScript=|x\.com\/i\/flow\/login|x\.com\/login|^https?:\/\/(www\.)?x\.com\/(\?|$)/,
  instagram: /accounts\/login|instagram\.com\/\?(?:next|hl=)|^https?:\/\/(www\.)?instagram\.com\/(\?|$)/,
  reddit:    /reddit\.com\/login\b/,
  tiktok:    /tiktok\.com\/login\b|^https?:\/\/(www\.)?tiktok\.com\/(\?|$)/,
  linkedin:  /linkedin\.com\/(uas\/login|authwall|checkpoint)\b/,
};
export function checkReachable(s, platform) {
  const finalUrl = s.page.url?.() ?? '';
  if (finalUrl.startsWith('chrome-error://')) {
    const err = new Error(`proxy_failed: ${platform} navigation never left chrome-error — proxy CONNECT failed (likely tunnel/sticky-session collision)`);
    err.banSignal = { signal: 'proxy_failed', healthy: false, details: { final_url: finalUrl, reason: 'chrome-error: proxy CONNECT failed' } };
    throw err;
  }
  const platformMarker = _LOGGED_OUT_MARKERS[platform];
  if (_AUTH_WALL.test(finalUrl) || /\/login\?/.test(finalUrl) || (platformMarker && platformMarker.test(finalUrl))) {
    const err = new Error(`auth_wall: ${platform} session not authenticated — landed at ${finalUrl}`);
    err.banSignal = { signal: 'checkpoint', healthy: false, details: { final_url: finalUrl, reason: 'redirected to platform login wall — stored cookies stale or session never authenticated' } };
    throw err;
  }
}

async function fetchSupabase(path) {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return null;
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) return null;
  return r.json();
}

export async function runAction(cfg) {
  const acct = await getSocialAccount(cfg.platform);
  if (!acct) { console.log(`FAIL: no active ${cfg.platform} account`); process.exit(1); }

  let character = null, product = null;
  const preapprovedTextProbe = process.env.SVC_TEXT || '';
  if (cfg.action !== 'browse') {
    const rows = await fetchSupabase(`character_social_accounts?social_account_id=eq.${acct.id}&select=characters(name,bio,personality,niche,handle,promoted_product_id,promotion_config)&limit=1`);
    character = rows?.[0]?.characters ?? null;
    // Accept a character-less post when SVC_TEXT is operator-supplied —
    // lets the UI path be verified without a character+product in prod DB.
    if (!character && !preapprovedTextProbe) {
      console.log('FAIL: no character linked'); process.exit(1);
    }
  }
  if (cfg.action === 'promote' || cfg.action === 'post_promote') {
    const productId = process.env.PRODUCT_ID || character?.promoted_product_id;
    if (!productId) { console.log('FAIL: no product configured'); process.exit(1); }
    const pr = await fetchSupabase(`products?id=eq.${productId}&select=name,description&limit=1`);
    product = pr?.[0] ?? null;
    if (!product) { console.log('FAIL: product not found'); process.exit(1); }
  }
  console.log(`[${cfg.platform}:${cfg.action}] acct=${acct.username}${character ? ` character=${character.name}` : ''}${product ? ` product=${product.name}` : ''}`);

  const { proxyUrl, persona } = await resolveAccountSession(acct);
  const label = `${cfg.platform}_${cfg.action}`;
  const s = await WSession.start({ label, proxy: proxyUrl, persona });
  // Cookie injection — required for any authenticated surface (compose,
  // notifications, etc). Filters by the target-platform domain so Twitter
  // cookies don't leak to a Reddit session etc. Same pattern as the
  // github/star/run.mjs trajectory. Without this, Twitter/Reddit/etc.
  // redirect to /login and the compose trajectory can't proceed.
  const domainFor = { twitter: 'x.com', reddit: 'reddit.com', instagram: 'instagram.com', tiktok: 'tiktok.com', linkedin: 'linkedin.com', discord: 'discord.com', github: 'github.com' };
  const wantedDomain = domainFor[cfg.platform];
  let banSignal = null;
  // Cookie freshness gate — bound the device-mismatch / token-staleness
  // failure mode that produced TikTok's silent logged-out shell. If the
  // jar is stale (no cookies_minted_at, or older than the freshness
  // window), skip injection, mark cookies stale, and exit. browse counts
  // as auth-required too (warming an unauthed session is pointless — the
  // engagement signal LinkedIn ingests is per-account).
  {
    try {
      const freshAll = loadFreshCookieJarOrFail(acct, { platform: cfg.platform, label, currentProxyUrl: proxyUrl, currentPersona: persona });
      const cookies = freshAll.filter(c => wantedDomain && (c.domain ?? '').includes(wantedDomain));
      if (cookies.length) {
        await s.ctx.addCookies(cookies).catch(e => console.log(`[${label}] cookie add err: ${e.message?.slice(0, 80)}`));
        console.log(`[${label}] injected ${cookies.length} ${wantedDomain} cookies (jar fresh)`);
      } else {
        // Jar fresh but no cookies for this domain — treat as stale to be safe.
        throw new CookieJarStaleError(`cookie_jar_no_domain_match: jar fresh but no ${wantedDomain} cookies`, { platform: cfg.platform, reason: 'no_domain_match' });
      }
    } catch (jarErr) {
      if (jarErr instanceof CookieJarStaleError) {
        // Stale jar — try inline relogin on the SAME WSession (mints fresh
        // cookies bound to the current proxy sticky). If unavailable or it
        // fails, fall back to the original exit path so the routine layer
        // can re-queue.
        if (typeof cfg.inlineRelogin === 'function') {
          console.log(`[${label}] ${jarErr.message?.slice(0, 80)} — attempting inline relogin`);
          const r = await cfg.inlineRelogin(s, acct).catch((e) => ({ ok: false, reason: e.message?.slice(0, 80) }));
          if (r?.ok) { console.log(`[${label}] inline relogin minted fresh cookies — continuing`); }
          else {
            banSignal = { signal: 'checkpoint', healthy: false, details: { reason: `${jarErr.message.slice(0, 120)} (inline relogin failed: ${r?.reason ?? 'unknown'})`, ...(jarErr.details ?? {}) } };
            if (acct.id) await markCookiesStale(acct.id).catch(() => {});
            await s.close().catch(() => {});
            console.log(`FAIL: ${jarErr.message}`);
            process.exit(1);
          }
        } else {
          banSignal = { signal: 'checkpoint', healthy: false, details: { reason: jarErr.message.slice(0, 200), ...(jarErr.details ?? {}) } };
          if (acct.id) await markCookiesStale(acct.id).catch(() => {});
          await s.close().catch(() => {});
          console.log(`FAIL: ${jarErr.message}`);
          process.exit(1);
        }
      } else { throw jarErr; }
    }
  }
  let resultValue = null;
  // Resolve a specific target if the caller provided one. Precedence:
  // TARGET_URL (full URL) > TARGET_USER (resolved per-platform) > SEARCH_QUERY
  // (resolved to hashtag/search URL) > cfg.feedUrl default. Targeted mode
  // uses cfg.targetedCommentGoal(text) if provided, otherwise cfg.commentGoal.
  const TARGET_URL = process.env.TARGET_URL || '';
  const TARGET_USER = process.env.TARGET_USER || '';
  const SEARCH_QUERY = process.env.SEARCH_QUERY || '';
  const REQUIRE_APPROVAL = process.env.REQUIRE_APPROVAL === '1';
  const preapprovedText = process.env.SVC_TEXT || '';
  let targetedMode = false;
  let feed;
  if (TARGET_URL) { feed = TARGET_URL; targetedMode = true; }
  else if (TARGET_USER && cfg.resolveUserUrl) { feed = cfg.resolveUserUrl(TARGET_USER); targetedMode = true; }
  else if (SEARCH_QUERY && cfg.resolveSearchUrl) { feed = cfg.resolveSearchUrl(SEARCH_QUERY); targetedMode = true; }
  else feed = typeof cfg.feedUrl === 'function' ? cfg.feedUrl(acct.username) : cfg.feedUrl;
  try {
    // Auth gate (navigate + chrome-error + auth_wall + SPA settle + assertAuthed)
    // lives in _shared/linkedin/auth-gate.mjs. Supports cfg.inlineRelogin so a
    // platform-specific helper can mint fresh cookies on the SAME WSession
    // when the first attempt hits auth_wall (verified live: linkedin engagement
    // running on stale-cookie account → relogin via emailPinChallenge → retry → PASS).
    const { runAuthGate } = await import('./linkedin/auth-gate.mjs');
    const gateRes = await runAuthGate({ s, cfg, acct, feed, label });
    if (!gateRes.ok) { banSignal = gateRes.banSignal; throw gateRes.error; }

    // Per-action handlers extracted to _shared/runner/handlers.mjs.
    const { handleBrowse, handlePost, handleComment } = await import('./runner/handlers.mjs');
    const ctx = { acct, character, product, preapprovedText, label, feed, targetedMode };
    if (cfg.action === 'browse') resultValue = await handleBrowse(s, cfg);
    else if (cfg.action === 'post' || cfg.action === 'post_promote') resultValue = await handlePost(s, cfg, ctx);
    else resultValue = await handleComment(s, cfg, ctx);
    // Race fix: write-API responses are captured asynchronously; verifyWriteAction
    // can run before the response lands in s.capturedResponses if banDetector is
    // called immediately. Poll until write_verify confirms or 6s elapses.
    if (cfg.action !== 'browse') {
      try {
        const { verifyWriteAction } = await import('../../../dist/platforms/_shared/write_verify.js');
        for (let i = 0; i < 12; i++) {
          const v = verifyWriteAction(cfg.platform, cfg.action, s.capturedResponses);
          if (!v.applicable || v.wrote) break;
          await humanIdlePause('short').catch(() => {});
        }
      } catch { /* best-effort race-fix; reclass below remains the source of truth */ }
    }
    banSignal = await cfg.banDetector(s.page, s.capturedResponses).catch(() => null);
    // Reclass: agent's done() might land on auth-wall or chrome-error — detector returns 'healthy' because no platform-ban keywords appear. Plus write-action verification (agent hallucinated done() but no API write fired).
    const successFinalUrl = s.page.url?.() ?? banSignal?.details?.final_url ?? '';
    const successBody = banSignal?.details?.body_text_sample ?? '';
    const successOnAuthWall = /\/(login|signin|sessions\/new|uas\/login|checkpoint|accounts\/login)\b/.test(successFinalUrl) || /\/login\?/.test(successFinalUrl);
    if (banSignal && successOnAuthWall && (banSignal.signal === 'healthy' || banSignal.signal === 'captcha_challenge')) {
      banSignal = { signal: 'checkpoint', healthy: false, details: { final_url: successFinalUrl, reason: `reclassified from ${banSignal.signal} — page on auth wall after agent loop`, prev_signal: banSignal.signal } };
    } else if (banSignal && successFinalUrl.startsWith('chrome-error://') && (banSignal.signal === 'healthy' || banSignal.signal === 'unknown')) {
      const sig = /HTTP ERROR 407|ERR_PROXY_AUTH/i.test(successBody) ? 'proxy_auth_failed' : /HTTP ERROR 4|ERR_HTTP_RESPONSE_CODE/i.test(successBody) ? 'ip_blocked' : 'proxy_failed';
      banSignal = { signal: sig, healthy: false, details: { final_url: successFinalUrl, reason: `reclassified from ${banSignal.signal} — chrome-error page (body: ${successBody.slice(0, 80)})`, prev_signal: banSignal.signal } };
    } else if (banSignal?.signal === 'healthy') {
      const { verifyWriteAction } = await import('../../../dist/platforms/_shared/write_verify.js');
      const v = verifyWriteAction(cfg.platform, cfg.action, s.capturedResponses);
      if (v.applicable && !v.wrote) banSignal = { signal: 'action_failed', healthy: false, details: { final_url: successFinalUrl, reason: `agent done()='${resultValue}' but no ${cfg.platform} ${cfg.action} write API call captured`, prev_signal: 'healthy' } };
    }
    console.log(`[ban-signal] ${banSignal?.signal}`);
    console.log(`PASS: ${resultValue}`);
  } catch (e) {
    // Order of precedence: outer-scope banSignal (set by inner chrome-error /
    // auth-wall checks before re-throwing) > error.banSignal (set by
    // checkReachable in specialized trajectories) > platform ban detector >
    // action_failed default. Pre-fix: outer catch overwrote the inner-set
    // banSignal with the platform detector's verdict, hiding proxy_failed.
    if (!banSignal) banSignal = e.banSignal ?? await cfg.banDetector(s.page, s.capturedResponses).catch(() => null);
    // Override-or-set reclass: same logic as the success path. Auth-wall →
    // checkpoint; chrome-error://chromewebdata/ → proxy_auth_failed/ip_blocked/
    // proxy_failed depending on body content. Healthy detector verdicts on
    // these states are misleading.
    const finalUrlForReclass = s.page.url?.() ?? banSignal?.details?.final_url ?? '';
    const bodySampleForReclass = banSignal?.details?.body_text_sample ?? '';
    const onAuthWallFinal = /\/(login|signin|sessions\/new|uas\/login|checkpoint|accounts\/login)\b/.test(finalUrlForReclass) || /\/login\?/.test(finalUrlForReclass);
    if (banSignal && onAuthWallFinal && (banSignal.signal === 'healthy' || banSignal.signal === 'captcha_challenge')) {
      banSignal = { signal: 'checkpoint', healthy: false, details: { final_url: finalUrlForReclass, reason: `reclassified from ${banSignal.signal} — landed on auth wall (cookies stale)`, prev_signal: banSignal.signal } };
    } else if (banSignal && finalUrlForReclass.startsWith('chrome-error://') && (banSignal.signal === 'healthy' || banSignal.signal === 'unknown')) {
      const sig2 = /HTTP ERROR 407|ERR_PROXY_AUTH/i.test(bodySampleForReclass) ? 'proxy_auth_failed' : /HTTP ERROR 4|ERR_HTTP_RESPONSE_CODE/i.test(bodySampleForReclass) ? 'ip_blocked' : 'proxy_failed';
      banSignal = { signal: sig2, healthy: false, details: { final_url: finalUrlForReclass, reason: `reclassified from ${banSignal.signal} — chrome-error page (body: ${bodySampleForReclass.slice(0, 80)})`, prev_signal: banSignal.signal } };
    }
    if (!banSignal) banSignal = { signal: 'action_failed', healthy: false, details: { final_url: s.page.url?.() ?? '', reason: e.message?.slice(0, 200) ?? 'no message' } };
    console.log(`[ban-signal] ${banSignal.signal}`);
    console.error('FAIL:', e.message?.slice(0, 200));
    process.exitCode = 1;
  } finally {
    if (banSignal) {
      try {
        const dir = join(process.cwd(), 'recordings', label);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: label, ...banSignal, ts: new Date().toISOString() }, null, 2));
      } catch (e) { console.log('[ban-signal] persist err:', e.message); }
      // Cookies-stale → mark the account so getSocialAccount skips it for 24h
      // and a different account is picked on the next routine tick. Without
      // this, the same dead account gets retried over and over, drowning the
      // queue and never letting healthy accounts run.
      if (banSignal.signal === 'checkpoint' && acct.id) {
        await markCookiesStale(acct.id).catch((e) => console.log('[mark-stale] err:', e.message?.slice(0, 80)));
      }
    }
    await s.close();
  }
}
