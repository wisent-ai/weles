/**
 * Shared action runner. Drives browse / organic_comment / promote across
 * every platform from a per-platform config.
 *
 * Config shape:
 *   platform:       string ('twitter' | 'instagram' | ...)
 *   action:         'browse' | 'organic_comment' | 'promote'
 *   feedUrl:        string | () => string — the landing URL for this action
 *   scrolls:        number — how many idle scrolls for browse
 *   banDetector:    async (page, responses) => BanSignal
 *   commentGoal:    string — prompt text for the agent loop when action is comment/promote
 *
 * Reads character + product context from the DB as needed. Writes
 * recordings/<platform>_<action>/ban_signal.json.
 */
import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';
import { generateOrganicComment, generatePromoteComment, generatePost } from './llm.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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

async function genComment({ character, product, variant, surfaceLabel, postTitle, postBody }) {
  const persona = { name: character.name, bio: character.bio, personality: character.personality, niche: character.niche };
  const post = { surface: surfaceLabel, title: postTitle, body: postBody };
  if (product) {
    return generatePromoteComment({ persona, post, product: { name: product.name, description: product.description, variant } });
  }
  return generateOrganicComment({ persona, post });
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
    if (!character && !(preapprovedTextProbe && (cfg.action === 'post' || cfg.action === 'post_promote'))) {
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
  const cookies = (acct.metadata?.cookies ?? []).filter(c => wantedDomain && (c.domain ?? '').includes(wantedDomain));
  if (cookies.length) {
    await s.ctx.addCookies(cookies).catch(e => console.log(`[${label}] cookie add err: ${e.message?.slice(0, 80)}`));
    console.log(`[${label}] injected ${cookies.length} ${wantedDomain} cookies`);
  }
  let banSignal = null;
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
    await s.goto(feed);
    // Proxy CONNECT failure: chromium serves chrome-error://chromewebdata/
    // ("This site can't be reached / ERR_TUNNEL_CONNECTION_FAILED"). Without
    // this branch the trajectory continues, the ban detector sees no ban
    // pattern in the chrome-error body and reports signal=healthy, hiding
    // proxy infra failures behind 'completed:healthy'. Emit a clean
    // proxy_failed signal instead so rerun_failed.mjs can retry these.
    try {
      const finalUrl = s.page.url?.() ?? '';
      if (finalUrl.startsWith('chrome-error://')) {
        banSignal = { signal: 'proxy_failed', healthy: false, details: { final_url: finalUrl, reason: 'chrome-error: proxy CONNECT failed (likely tunnel/sticky-session issue)' } };
        throw new Error(`proxy_failed: ${cfg.platform} navigation never left chrome-error — proxy CONNECT failed for ${feed}`);
      }
      const onAuthWall = /\/(login|signin|sessions\/new|uas\/login|checkpoint)\b/.test(finalUrl) || /\/login\?/.test(finalUrl);
      if (onAuthWall && cfg.action !== 'browse') {
        banSignal = { signal: 'checkpoint', healthy: false, details: { final_url: finalUrl, reason: 'redirected to platform login wall — stored cookies stale or session never authenticated' } };
        throw new Error(`auth_wall: ${cfg.platform} session not authenticated — landed at ${finalUrl}`);
      }
    } catch (authErr) { if (banSignal && (banSignal.signal === 'checkpoint' || banSignal.signal === 'proxy_failed')) throw authErr; /* otherwise continue */ }

    // SPA-loaded surfaces (Twitter timeline, Instagram feed, LinkedIn feed,
    // Reddit comments) populate via XHR after the initial HTML loads. Without
    // this wait, the agent loop runs immediately, sees an empty layout, and
    // give_up()s — visible as exit-1 with only the goto screenshot in
    // recordings (no agent-step screenshots). 3s gives the timeline + reply
    // composer time to render before the agent's first action.
    if (cfg.action !== 'browse') await s.page.waitForTimeout(3000).catch(() => {});
    // Re-check the URL after the SPA settle. LinkedIn's /feed/ returns 200 OK
    // on stale cookies, then JS-redirects to /uas/login during the wait — the
    // post-goto check at line 130 misses this. Without the re-check, the agent
    // loop runs against the login page, fails to find Comment buttons,
    // give_ups, and the linkedin ban detector returns 'healthy' (PerimeterX
    // isn't in the default captcha frame regex), masking the cookies-stale
    // failure mode behind 'completed:healthy'.
    if (cfg.action !== 'browse') {
      const settledUrl = s.page.url?.() ?? '';
      const onAuthWallAfter = /\/(login|signin|sessions\/new|uas\/login|checkpoint|accounts\/login)\b/.test(settledUrl) || /\/login\?/.test(settledUrl);
      if (onAuthWallAfter) {
        banSignal = { signal: 'checkpoint', healthy: false, details: { final_url: settledUrl, reason: 'SPA-redirected to login wall during settle — stored cookies stale' } };
        throw new Error(`auth_wall: ${cfg.platform} session redirected to login during SPA settle — landed at ${settledUrl}`);
      }
    }

    if (cfg.action === 'browse') {
      for (let i = 0; i < (cfg.scrolls ?? 6); i++) {
        await s.page.evaluate(() => window.scrollBy(0, window.innerHeight * (0.6 + Math.random() * 0.6)));
        await s.page.waitForTimeout(900 + Math.floor(Math.random() * 1400));
      }
      resultValue = `scrolled ${cfg.scrolls ?? 6}x`;
    } else if (cfg.action === 'post' || cfg.action === 'post_promote') {
      // Original post: generate short content, drive the compose UI via agent.
      // Product-mention version goes through generatePost with product set so
      // the LLM weaves it in naturally instead of opening with brand.
      let text = preapprovedText;
      if (!text) {
        if (!character) throw new Error('no character — cannot LLM-generate post without persona');
        const personaCtx = { name: character.name, bio: character.bio, personality: character.personality, niche: character.niche };
        text = await generatePost({ persona: personaCtx, surface: cfg.platform, product: product ?? undefined });
        console.log(`[post-text] ${text.slice(0, 140)}...`);
      }
      if (cfg.action === 'post_promote' && REQUIRE_APPROVAL && !preapprovedText) {
        const dir = join(process.cwd(), 'recordings', label);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'pending_review.json'), JSON.stringify({
          account_id: acct.id, username: acct.username, action: label,
          surface_label: typeof cfg.surfaceLabel === 'function' ? cfg.surfaceLabel(acct, feed) : cfg.surfaceLabel,
          product: product ? { name: product.name } : null,
          variant: (process.env.VARIANT || character?.promotion_config?.variant || 'mention').toLowerCase(),
          post_text: text, ts: new Date().toISOString(),
        }, null, 2));
        console.log('PASS: pending_review (approval required, not posted)');
        resultValue = 'pending_review';
      } else {
        const r = await execute(s, cfg.postGoal(text), {}); // no flow cache — text is per-tick
        resultValue = r.value;
      }
    } else {
      const surfaceLabel = typeof cfg.surfaceLabel === 'function' ? cfg.surfaceLabel(acct, feed) : (cfg.surfaceLabel ?? feed);
      const picked = await (cfg.pickPost?.(s).catch(e => { console.log(`[${label}] pickPost failed: ${e.message?.slice(0, 80)}`); return { postTitle: '', postBody: '' }; }) ?? Promise.resolve({ postTitle: '', postBody: '' }));
      // pickPost returns empty when the captured-response body is truncated
      // (8KB cap on Twitter/Reddit JSON), the regex misses, or the SPA hasn't
      // loaded posts yet. The /api/llm/generate endpoint requires a non-empty
      // post.title for comment/promote tasks (returns 400). Substitute a
      // surface-aware placeholder so genComment doesn't 400 — the LLM still
      // produces a generic on-topic comment from persona + surface alone.
      const postTitle = picked.postTitle || `post on ${typeof surfaceLabel === 'function' ? surfaceLabel(acct, feed) : (surfaceLabel || cfg.platform)}`;
      const postBody = picked.postBody || '';
      let text = preapprovedText;
      if (!text) {
        text = await genComment({
          character, product,
          variant: (process.env.VARIANT || character?.promotion_config?.variant || 'mention').toLowerCase(),
          surfaceLabel, postTitle, postBody,
        });
        console.log(`[comment-text] ${text.slice(0, 140)}...`);
      } else {
        console.log(`[preapproved] using operator-reviewed text (${text.length} chars)`);
      }
      if (cfg.action === 'promote' && REQUIRE_APPROVAL && !preapprovedText) {
        const dir = join(process.cwd(), 'recordings', label);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'pending_review.json'), JSON.stringify({
          account_id: acct.id, username: acct.username, action: label,
          post_url: targetedMode ? feed : null, surface_label: surfaceLabel,
          post_title: postTitle, post_body: (postBody || '').slice(0, 600),
          character: character ? { name: character.name, niche: character.niche } : null,
          product: product ? { name: product.name } : null,
          variant: (process.env.VARIANT || character?.promotion_config?.variant || 'mention').toLowerCase(),
          comment_text: text, ts: new Date().toISOString(),
        }, null, 2));
        console.log('PASS: pending_review (approval required, not submitted)');
        resultValue = 'pending_review';
      } else {
        const goalFn = targetedMode && cfg.targetedCommentGoal ? cfg.targetedCommentGoal : cfg.commentGoal;
        const r = await execute(s, goalFn(text), { flowName: label });
        resultValue = r.value;
      }
    }
    banSignal = await cfg.banDetector(s.page, s.capturedResponses).catch(() => null);
    // Same auth-wall reclassification as the catch branch — agent might
    // 'done(value="commented")' even when the page silently redirected to
    // /uas/login (the agent's vision interprets PerimeterX iframe text or
    // gives up cleanly). Don't let that masquerade as healthy or as
    // captcha_challenge.
    const successFinalUrl = s.page.url?.() ?? banSignal?.details?.final_url ?? '';
    const successOnAuthWall = /\/(login|signin|sessions\/new|uas\/login|checkpoint|accounts\/login)\b/.test(successFinalUrl) || /\/login\?/.test(successFinalUrl);
    if (banSignal && successOnAuthWall && (banSignal.signal === 'healthy' || banSignal.signal === 'captcha_challenge')) {
      banSignal = { signal: 'checkpoint', healthy: false, details: { final_url: successFinalUrl, reason: `reclassified from ${banSignal.signal} — page on auth wall after agent loop`, prev_signal: banSignal.signal } };
      console.log(`[ban-signal] reclassified ${banSignal.details.prev_signal} → checkpoint (auth wall: ${successFinalUrl})`);
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
    // Override-or-set: if ban detector said 'healthy' or 'captcha_challenge'
    // but the URL is on a known login wall, the page is actually unauthenticated
    // (cookies stale). PerimeterX iframe on /uas/login isn't a real captcha
    // challenge, it's a fingerprint-gated login wall. Same for LinkedIn's
    // /login/ generic. Reclassify as 'checkpoint' so retry pipelines treat it
    // as needing a login refresh instead of a captcha-solver attempt.
    const finalUrlForReclass = s.page.url?.() ?? banSignal?.details?.final_url ?? '';
    const onAuthWallFinal = /\/(login|signin|sessions\/new|uas\/login|checkpoint|accounts\/login)\b/.test(finalUrlForReclass) || /\/login\?/.test(finalUrlForReclass);
    if (banSignal && onAuthWallFinal && (banSignal.signal === 'healthy' || banSignal.signal === 'captcha_challenge')) {
      banSignal = { signal: 'checkpoint', healthy: false, details: { final_url: finalUrlForReclass, reason: `reclassified from ${banSignal.signal} — landed on auth wall (cookies stale)`, prev_signal: banSignal.signal } };
    }
    if (!banSignal) banSignal = { signal: 'action_failed', healthy: false, details: { final_url: s.page.url?.() ?? '', reason: e.message?.slice(0, 200) ?? 'no message' } };
    console.log(`[ban-signal] ${banSignal.signal}`);
    console.log('FAIL:', e.message?.slice(0, 200));
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
