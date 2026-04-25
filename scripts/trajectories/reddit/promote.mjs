/**
 * Reddit promote trajectory. Same shape as organic_comment but generates a
 * persona-voiced comment that authentically mentions the character's promoted
 * product. Only enqueued by the cron when isPromoteEligible() passes
 * upstream — this trajectory does NOT re-check eligibility, the lifecycle
 * gate is the source of truth.
 *
 * Args via env: SUBREDDIT (required), PRODUCT_ID (required), VARIANT
 * ("link"|"mention", default "mention").
 */
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';
import { generatePromoteComment } from '../_shared/llm.mjs';
import { detectRedditBanSignals } from '../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SUBREDDIT = process.env.SUBREDDIT || 'popular';
const TARGET_URL = process.env.TARGET_URL || '';        // if set, skip listing pick
const PRODUCT_ID = process.env.PRODUCT_ID;
const VARIANT = (process.env.VARIANT || 'mention').toLowerCase();
const REQUIRE_APPROVAL = process.env.REQUIRE_APPROVAL === '1';
if (!PRODUCT_ID) { console.log('FAIL: PRODUCT_ID required'); process.exit(1); }

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }

async function fetchSupabase(path) {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) return null;
  const r = await fetch(`${url}/rest/v1/${path}`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  if (!r.ok) return null;
  return r.json();
}

const charRows = await fetchSupabase(`character_social_accounts?social_account_id=eq.${acct.id}&select=characters(name,bio,personality,niche,handle)&limit=1`);
const character = charRows?.[0]?.characters;
const productRows = await fetchSupabase(`products?id=eq.${PRODUCT_ID}&select=name,description&limit=1`);
const product = productRows?.[0];
if (!character) { console.log('FAIL: no character linked'); process.exit(1); }
if (!product) { console.log('FAIL: product not found'); process.exit(1); }
console.log(`[promote] acct=${acct.username} character=${character.name} product=${product.name} variant=${VARIANT}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_promote', proxy: proxyUrl, persona });
let banSignal = null;
try {
  let postUrl = null, postTitle = '', postBody = '';

  if (TARGET_URL) {
    // Caller-supplied specific thread (campaign path). Fetch the post JSON
    // for title/body context so the LLM prompt stays grounded.
    postUrl = TARGET_URL;
    const jsonUrl = TARGET_URL.replace(/\/?$/, '.json?raw_json=1');
    await s.goto(jsonUrl);
    const threadResp = s.capturedResponses.find(r => r.url.includes(TARGET_URL.split('://')[1].split('?')[0]) && r.url.includes('.json'));
    try {
      const data = JSON.parse(threadResp?.body ?? '[]');
      const first = Array.isArray(data) ? data[0]?.data?.children?.[0]?.data : data?.data?.children?.[0]?.data;
      if (first) { postTitle = first.title || ''; postBody = first.selftext || ''; }
    } catch (e) { console.log('[thread-parse]', e.message); }
  } else {
    // No explicit target — pick from the subreddit listing (organic path).
    // Use page.evaluate fetch — capturedResponses truncates bodies to 8KB.
    const sortPath = SUBREDDIT === 'popular' || SUBREDDIT === 'all' ? `/r/${SUBREDDIT}/new` : `/r/${SUBREDDIT}`;
    await s.goto('https://www.reddit.com/');
    const listingUrl = `https://www.reddit.com${sortPath}/.json?limit=50&raw_json=1`;
    const data = await s.page.evaluate(async (u) => { try { const r = await fetch(u, { credentials: 'include' }); if (!r.ok) return null; return await r.json(); } catch { return null; } }, listingUrl).catch(() => null);
    try {
      const candidates = (data?.data?.children ?? [])
        .map(c => c.data)
        .filter(p => p && !p.locked && !p.archived && p.num_comments < 2000 && p.num_comments > 2);
      const pick = candidates[Math.floor(Math.random() * Math.min(candidates.length, 12))];
      if (pick) { postUrl = `https://www.reddit.com${pick.permalink}`; postTitle = pick.title || ''; postBody = pick.selftext || ''; }
    } catch (e) { console.log('[listing-parse]', e.message); }
  }
  if (!postUrl) throw new Error('no eligible post found');

  const preapprovedText = process.env.SVC_TEXT || '';

  let commentText = preapprovedText;
  if (!commentText) {
    commentText = await generatePromoteComment({
      persona: { name: character.name, bio: character.bio, personality: character.personality, niche: character.niche },
      post: { surface: `r/${SUBREDDIT}`, title: postTitle, body: postBody },
      product: { name: product.name, description: product.description, variant: VARIANT },
    });
    console.log(`[comment-text] ${commentText.slice(0, 160)}...`);
  } else {
    console.log(`[preapproved] using operator-reviewed text (${commentText.length} chars)`);
  }

  if (REQUIRE_APPROVAL && !preapprovedText) {
    const dir = join(process.cwd(), 'recordings', 'reddit_promote');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pending_review.json'), JSON.stringify({
      account_id: acct.id, username: acct.username, action: 'reddit_promote',
      subreddit: SUBREDDIT, product_id: PRODUCT_ID, variant: VARIANT,
      post_url: postUrl, post_title: postTitle, post_body: postBody.slice(0, 600),
      character: { name: character.name, niche: character.niche },
      product: { name: product.name },
      comment_text: commentText, ts: new Date().toISOString(),
    }, null, 2));
    console.log('PASS: pending_review (approval required, not submitted)');
    await s.close();
    process.exit(0);
  }

  await s.goto(postUrl);
  const result = await execute(s, `You are on a reddit post. Find the comment textarea (placeholder "Add a comment" or "join the conversation"). fill(target="add a comment", value=${JSON.stringify(commentText)}). Then js_click(text="Comment") to submit. done(value="promoted"). Do NOT navigate(). Do NOT give_up.`, { flowName: 'reddit_promote' });
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${banSignal?.signal}`);
  console.log('PASS:', result.value);
} catch (e) {
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = join(process.cwd(), 'recordings', 'reddit_promote');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_promote', subreddit: SUBREDDIT, product_id: PRODUCT_ID, variant: VARIANT, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
