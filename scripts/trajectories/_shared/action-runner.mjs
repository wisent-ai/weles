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
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';
import { generateOrganicComment, generatePromoteComment, generatePost } from './llm.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

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
    // Auth check before doing any work — many trajectories run with stale cookies
    // and silently land on the platform's /login page. Without this, organic_comment
    // hits 'post.title required' from genComment, post hits 'no compose modal',
    // promote/like/follow waste an LLM call. Detect the redirect-to-login state
    // and emit a clean checkpoint signal instead.
    try {
      const finalUrl = s.page.url?.() ?? '';
      const onAuthWall = /\/(login|signin|sessions\/new|uas\/login|checkpoint)\b/.test(finalUrl) || /\/login\?/.test(finalUrl);
      if (onAuthWall && cfg.action !== 'browse') {
        banSignal = { signal: 'checkpoint', healthy: false, details: { final_url: finalUrl, reason: 'redirected to platform login wall — stored cookies stale or session never authenticated' } };
        throw new Error(`auth_wall: ${cfg.platform} session not authenticated — landed at ${finalUrl}`);
      }
    } catch (authErr) { if (banSignal?.signal === 'checkpoint') throw authErr; /* otherwise continue */ }

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
      const { postTitle, postBody } = await (cfg.pickPost?.(s) ?? Promise.resolve({ postTitle: '', postBody: '' }));
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
    console.log(`[ban-signal] ${banSignal?.signal}`);
    console.log(`PASS: ${resultValue}`);
  } catch (e) {
    banSignal = await cfg.banDetector(s.page, s.capturedResponses).catch(() => null);
    if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
    console.log('FAIL:', e.message?.slice(0, 200));
    process.exitCode = 1;
  } finally {
    if (banSignal) {
      try {
        const dir = join(process.cwd(), 'recordings', label);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: label, ...banSignal, ts: new Date().toISOString() }, null, 2));
      } catch (e) { console.log('[ban-signal] persist err:', e.message); }
    }
    await s.close();
  }
}
