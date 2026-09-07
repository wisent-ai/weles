/**
 * Reddit organic browse — reads the declared origin, scrolls, exits.
 * Lowest-friction observation in the warming/mature/active menu. No clicks.
 *
 * The origin and the dwell budget are declaration content: admission resolved
 * reddit.browse and its {subreddit} before this process existed, so nothing
 * here names a URL or a scroll count. Uses the account's stored persona +
 * proxy via resolveAccountSession. Ban-detector at session close writes
 * ban_signal.json into recordings/reddit_browse/ for worker pool.
 */
import { getSocialAccount, resolveAccountSession } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { detectRedditBanSignals } from '../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { humanIdlePause, humanScroll } from '../../../dist/human/mouse.js';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { declaredObservation } from '../_shared/observation.mjs';

const observed = declaredObservation();

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
console.log(`[browse] acct=${acct.username} origin=${observed.origin}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_browse', proxy: proxyUrl, persona });
let banSignal = null;
try {
  await s.goto(observed.origin);
  // Idle scroll: simulate skimming the feed without clicking anything, for
  // exactly as long as the declared dwell budget allows.
  for (let i = 0; i < observed.scrolls; i++) {
    await humanScroll(s.page, 1200, 3);
    await humanIdlePause(observed.dwellMs);
  }
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch((e) => ({ healthy: false, signal: 'unknown_error', details: { detector_error: e.message } }));
  console.log(`[ban-signal] ${banSignal.signal}`);
  console.log(`PASS: scrolled ${observed.scrolls}x on ${observed.origin}`);
} catch (e) {
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = runRecordingsDir('reddit_browse');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_browse', observation: observed.observation, origin: observed.origin, reads: observed.reads, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
