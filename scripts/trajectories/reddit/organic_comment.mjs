/**
 * Reddit organic comment — picks a recent post in a niche sub, generates a
 * persona-voiced comment via the LLM proxy, submits it.
 *
 * Args via env: SUBREDDIT (required for now). Character context fetched from
 * social_accounts → character_social_accounts → characters. Ban-detector at
 * session close writes ban_signal.json into recordings/reddit_organic_comment/.
 */
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';
import { generateOrganicComment } from '../_shared/llm.mjs';
import { checkReachable } from '../_shared/action-runner.mjs';
import { detectRedditBanSignals } from '../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SUBREDDIT = process.env.SUBREDDIT || 'popular';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }

async function fetchCharacter(accountId) {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key || !accountId) return null;
  const r = await fetch(`${url}/rest/v1/character_social_accounts?social_account_id=eq.${accountId}&select=characters(name,bio,personality,niche,handle)&limit=1`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
  });
  if (!r.ok) return null;
  const rows = await r.json();
  return rows[0]?.characters ?? null;
}

const character = await fetchCharacter(acct.id);
if (!character) { console.log('FAIL: no character linked to account'); process.exit(1); }
console.log(`[comment] acct=${acct.username} character=${character.name} sub=${SUBREDDIT}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_organic_comment', proxy: proxyUrl, persona });
let banSignal = null;
try {
  // Inject saved reddit cookies — anonymous .json fetches hit the JS-challenge
  // wall on residential proxies. With session cookies the listing returns directly.
  const cookies = (acct.metadata?.cookies ?? []).filter(c => (c.domain ?? '').includes('reddit.com'));
  if (cookies.length) await s.ctx.addCookies(cookies).catch(() => {});
  // /r/popular surfaces mega-threads with thousands of comments. Pull /new for
  // fresher posts. Capture body via page.evaluate fetch (not capturedResponses,
  // which truncates to 8KB and breaks JSON.parse on listing payloads).
  const sortPath = SUBREDDIT === 'popular' || SUBREDDIT === 'all' ? `/r/${SUBREDDIT}/new` : `/r/${SUBREDDIT}`;
  await s.goto('https://www.reddit.com/');
  const listingUrl = `https://www.reddit.com${sortPath}/.json?limit=50&raw_json=1`;
  const data = await s.page.evaluate(async (u) => { try { const r = await fetch(u, { credentials: 'include' }); if (!r.ok) return null; return await r.json(); } catch { return null; } }, listingUrl).catch(() => null);
  let postUrl = null, postTitle = '', postBody = '';
  try {
    const candidates = (data?.data?.children ?? [])
      .map(c => c.data)
      .filter(p => p && !p.locked && !p.archived && p.num_comments < 2000);
    const pick = candidates[Math.floor(Math.random() * Math.min(candidates.length, 12))];
    if (pick) { postUrl = `https://www.reddit.com${pick.permalink}`; postTitle = pick.title || ''; postBody = pick.selftext || ''; }
  } catch (e) { console.log('[listing-parse]', e.message); }
  if (!postUrl) throw new Error('no eligible post found');

  const commentText = await generateOrganicComment({
    persona: { name: character.name, bio: character.bio, personality: character.personality, niche: character.niche },
    post: { surface: `r/${SUBREDDIT}`, title: postTitle, body: postBody },
  });
  console.log(`[comment-text] ${commentText.slice(0, 120)}...`);

  await s.goto(postUrl);
  checkReachable(s, 'reddit');
  const result = await execute(s, `You are on a reddit post. Find the comment textarea (placeholder "Add a comment" or "join the conversation"). fill(target="add a comment", value=${JSON.stringify(commentText)}). Then js_click(text="Comment") to submit. done(value="commented"). Do NOT navigate(). Do NOT give_up.`, { flowName: 'reddit_organic_comment' });
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
      const dir = join(process.cwd(), 'recordings', 'reddit_organic_comment');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_organic_comment', subreddit: SUBREDDIT, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
