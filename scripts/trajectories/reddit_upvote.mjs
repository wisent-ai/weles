import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';
import { detectRedditBanSignals } from '../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const URL = 'https://www.reddit.com/r/test';
const GOAL = `You are already logged in via cookies. Wait 3 seconds for posts to load. Use js_click(text="upvote") to upvote the first post. done(value="upvoted"). Do NOT give_up.`;

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_upvote', proxy: proxyUrl, persona });
let banSignal = null;
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'reddit_upvote',
  });
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch((e) => ({ healthy: false, signal: 'unknown_error', details: { detector_error: e.message } }));
  console.log(`[ban-signal] ${banSignal.signal}`);
  console.log('PASS:', result.value);
} catch (e) {
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = join(process.cwd(), 'recordings', 'reddit_upvote');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
