import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../../dist/utils/credentials.js';
import { WSession } from '../../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
import { detectRedditBanSignals } from '../../../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../../_shared/auth-probe.mjs';
import { runRecordingsDir } from '../../../../../dist/session/run-recordings.js';

const SUBREDDIT = (process.env.SUBREDDIT || 'popular').replace(/^r\//, '');
const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_upvote_new', proxy: proxyUrl, persona, targetHost: 'www.reddit.com' });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /reddit\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  // shreddit (www.reddit.com) variant. Each <shreddit-post> renders inline
  // action buttons inside its shadow tree: <button>Upvote</button>,
  // <button>Downvote</button>, comments link, share, etc. (verified via
  // shadow-DOM probe 2026-05-02 — text content "Upvote" at 32x32, sibling
  // "Downvote" at +40x). Playwright's locator pierces open shadow roots, so
  // `shreddit-post button:has-text("Upvote")` resolves the actual button.
  // After click the same button toggles aria-pressed=true.
  const baseUrl = TARGET_URL || `https://www.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/`;
  const url = baseUrl.replace(/^https?:\/\/(old|new)\.reddit\.com/, 'https://www.reddit.com');
  await s.goto(url);
  checkReachable(s, 'reddit');
  await humanIdlePause('deliberate');
  try { await assertAuthed('reddit', s, { label: 'reddit_upvote_new' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // Pick the first post we have not already voted on. Iterate rendered
  // shreddit-post elements; skip any whose Upvote button already has
  // aria-pressed=true.
  const posts = s.page.locator('shreddit-post');
  const count = await posts.count();
  let pickedPostId = null;
  let upvoteBtn = null;
  for (let i = 0; i < Math.min(count, 12); i++) {
    const post = posts.nth(i);
    const fullname = await post.getAttribute('post-id').catch(() => null);
    const id = await post.getAttribute('id').catch(() => null);
    const btn = post.locator('button:has-text("Upvote")').first();
    if (!(await btn.count())) continue;
    const pressed = await btn.getAttribute('aria-pressed').catch(() => null);
    if (pressed === 'true') continue;
    pickedPostId = fullname || id || null;
    upvoteBtn = btn;
    break;
  }
  if (!upvoteBtn) throw new Error('no eligible (not-yet-upvoted) shreddit-post upvote button found');
  await upvoteBtn.scrollIntoViewIfNeeded();
  await humanIdlePause('short');
  console.log(`[upvote_new] picked post id=${pickedPostId}`);
  await humanClickLocator(s.page, upvoteBtn);
  // Wait for aria-pressed=true on the SAME picked button. MutationObserver
  // catches the attribute flip even on async toggle paths. 15s ceiling so a
  // dead click surfaces instead of hanging the trajectory.
  await upvoteBtn.evaluate((b) => new Promise((res, rej) => {
    if (b.getAttribute('aria-pressed') === 'true') return res(true);
    const obs = new MutationObserver(() => { if (b.getAttribute('aria-pressed') === 'true') { obs.disconnect(); res(true); } });
    obs.observe(b, { attributes: true, attributeFilter: ['aria-pressed'] });
    setTimeout(() => { obs.disconnect(); rej(new Error('aria-pressed never flipped to true within 15s')); }, 15000);
  }));
  ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: upvoted ${pickedPostId || ''}`);
} catch (e) {
  ban = e.banSignal ?? await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = runRecordingsDir('reddit_upvote_new'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_upvote_new', subreddit: SUBREDDIT, target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
