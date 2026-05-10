/**
 * Reddit organic browse — navigates to a subreddit, scrolls, exits.
 * Lowest-friction action in the warming/mature/active menu. No clicks.
 *
 * Args via env: SUBREDDIT (default 'popular'). Uses the account's stored
 * persona + proxy via resolveAccountSession. Ban-detector at session close
 * writes ban_signal.json into recordings/reddit_browse/ for worker pool.
 */
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { detectRedditBanSignals } from '../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { humanIdlePause, humanScroll } from '../../../dist/human/mouse.js';

const SUBREDDIT = process.env.SUBREDDIT || 'popular';
const SCROLL_COUNT = parseInt(process.env.SCROLL_COUNT || '8', 10);

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
console.log(`[browse] acct=${acct.username} sub=${SUBREDDIT}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_browse', proxy: proxyUrl, persona });
let banSignal = null;
try {
  await s.goto(`https://www.reddit.com/r/${SUBREDDIT}/`);
  // Idle scroll: simulate skimming the feed without clicking anything.
  for (let i = 0; i < SCROLL_COUNT; i++) {
    await humanScroll(s.page, 1200, 3);
    await humanIdlePause();
  }
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch((e) => ({ healthy: false, signal: 'unknown_error', details: { detector_error: e.message } }));
  console.log(`[ban-signal] ${banSignal.signal}`);
  console.log(`PASS: scrolled ${SCROLL_COUNT}x on r/${SUBREDDIT}`);
} catch (e) {
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = join(process.cwd(), 'recordings', 'reddit_browse');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_browse', subreddit: SUBREDDIT, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
