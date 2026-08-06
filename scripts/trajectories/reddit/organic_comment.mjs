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
import { generateOrganicComment } from '../_shared/llm.mjs';
import { checkReachable } from '../_shared/action-runner.mjs';
import { detectRedditBanSignals } from '../../../dist/platforms/reddit/ban_signals.js';
import { humanScroll, humanIdlePause, humanClickLocator, humanHoverDwell } from '../../../dist/human/mouse.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { probeCommentVisibility, probeShadowban } from '../../../dist/platforms/reddit/shadowban_probe.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';

// Newbie-tolerant subs — high comment volume, light AutoMod, no karma gate.
// The default 'popular' lands on mega-threads where comments are routinely
// auto-removed by sub-specific filters even when the account is fine; that
// produces false-positive shadowban verdicts for our verifier. When SUBREDDIT
// is unset OR the caller passes 'popular'/'all', pick from this curated list
// instead. Verified 2026-04-29 across the cohort: comments to r/test took
// 6/10 hits to AutoMod removal; same accounts had 8/10 successful comments
// in r/CasualConversation in the same session window.
const NEWBIE_FRIENDLY_SUBS = [
  'CasualConversation', 'AskOldPeople', 'AskReddit', 'NoStupidQuestions',
  'mildlyinteresting', 'todayilearned', 'AskMen', 'AskWomen',
];
const RAW_SUBREDDIT = process.env.SUBREDDIT || 'popular';
const SUBREDDIT = (RAW_SUBREDDIT === 'popular' || RAW_SUBREDDIT === 'all')
  ? NEWBIE_FRIENDLY_SUBS[Math.floor(Math.random() * NEWBIE_FRIENDLY_SUBS.length)]
  : RAW_SUBREDDIT;

// Deferred clean-session verify: wait this long after submit before re-checking
// the comment's public visibility via a fresh proxy + no cookies. Reddit's
// async spam classifier runs on a 60-300s delay — checking inside that window
// produces "looks fine, then minutes later it's gone" false positives.
const DEFER_VERIFY_MS = Number(process.env.DEFER_VERIFY_MS ?? 300_000); // 5 min

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }

async function fetchCharacter(accountId) {
  const url = process.env.WELES_DATABASE_URL ?? '';
  const key = process.env.WELES_DATABASE_TOKEN ?? '';
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

  // Translate www.reddit.com permalink → old.reddit.com so the comment
  // composer is a plain visible <textarea name="text"> rather than the
  // <shreddit-composer> shadow-DOM widget.
  const oldPostUrl = postUrl.replace(/^https?:\/\/(www\.)?reddit\.com/, 'https://old.reddit.com');
  await s.goto(oldPostUrl);
  checkReachable(s, 'reddit');

  // Pre-comment dwell — read the post, scroll through some comments, hover
  // a couple of names. Reddit's behavioral classifier reads this telemetry
  // as part of its post-submit shadowban scoring; a goto -> immediate-fill
  // -> submit flow scores far worse than goto -> 30-60s of scroll/hover
  // -> submit. Cost: 30-60s extra wall time per comment. Worth it.
  await humanIdlePause('deliberate');
  await humanScroll(s.page, 1400, 3).catch(() => {});
  await humanIdlePause('deliberate');
  // Hover a username link if present — triggers rpl-hovercard:after-show
  // which Reddit's anti-spam scoring reads as "user inspected the OP".
  // Atom: humanHoverDwell handles all timing + viewport-bounds + fail-quiet.
  await humanHoverDwell(
    s.page,
    s.page.locator('a[href*="/user/"], a[href*="/u/"]').filter({ visible: true }).first(),
  ).catch(() => false);
  await humanScroll(s.page, 800, 2).catch(() => {});

  // Deterministic submit: same selectors as reddit_comment.mjs. textarea
  // [name="text"] first visible (top-level reply form), submit via
  // form-scoped button.save / button[type="submit"], verify by waiting
  // for the comment body to appear in the page.
  const ta = s.page.locator('textarea[name="text"]').filter({ visible: true }).first();
  await ta.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, ta);
  await humanIdlePause('short');
  await ta.focus();
  await humanType(s.page, commentText);
  await humanIdlePause('short');
  const submitBtn = ta.locator('xpath=ancestor::form[1]').locator('button.save, button[type="submit"]').first();
  await submitBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, submitBtn);
  // Confirm the body appears in page text — local visibility post-submit.
  await s.page.waitForFunction(
    (body) => (document.body?.innerText ?? '').includes(body),
    commentText,
  );
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${banSignal?.signal}`);
  console.log('PASS: commented');

  // Deferred clean-session verify — Reddit's async spam classifier runs on a
  // 60-300s delay. The same-session 60s polling check inside execute() above
  // can return PASS while the comment is removed minutes later. Wait
  // DEFER_VERIFY_MS, then re-fetch the user's public comments via a fresh
  // proxy (different sticky exit IP, no cookies). If our comment is missing
  // from that clean view, mark this trajectory as a deferred-shadowban hit.
  // We can't reliably get the comment id from the agent-loop submit, so the
  // probe falls back to a multi-vantage about.json check — if the account
  // itself is shadowbanned, that's the same root failure.
  if (DEFER_VERIFY_MS > 0 && !banSignal) {
    const realHandle = await s.page.evaluate(async () => {
      try { const r = await fetch('/api/me.json', { credentials: 'include' }); const j = await r.json(); return j?.data?.name ?? null; } catch { return null; }
    }).catch(() => null);
    if (realHandle) {
      console.log(`[deferred-verify] waiting ${DEFER_VERIFY_MS / 1000}s before clean-session probe of ${realHandle}`);
      await new Promise(r => setTimeout(r, DEFER_VERIFY_MS));  // allow-raw-playwright: polling/rate-limit loop
      const probe = await probeShadowban(realHandle, 3).catch((e) => ({ verdict: 'indeterminate', vantages: [], err: e?.message }));
      console.log(`[deferred-verify] verdict=${probe.verdict}`);
      if (probe.verdict === 'shadowbanned') {
        banSignal = { signal: 'shadowbanned', healthy: false, details: { real_handle: realHandle, reason: 'multi-vantage about.json 404 after deferred verify', vantages: probe.vantages } };
        // Auto-flag: pull from rotation.
        const databaseUrl = process.env.WELES_DATABASE_URL ?? '';
        const key = process.env.WELES_DATABASE_TOKEN ?? '';
        if (databaseUrl && key && acct.id) {
          await fetch(`${databaseUrl}/rest/v1/social_accounts?id=eq.${acct.id}`, {
            method: 'PATCH',
            headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'shadowbanned' }),
          }).catch(() => {});
          console.log(`[deferred-verify] auto-flagged ${acct.username} status=shadowbanned`);
        }
        throw new Error(`account shadowbanned (deferred verify, ${probe.vantages.filter(v => v.status === 404).length}/${probe.vantages.length} vantages 404)`);
      }
    }
  }
} catch (e) {
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = runRecordingsDir('reddit_organic_comment');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_organic_comment', subreddit: SUBREDDIT, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
