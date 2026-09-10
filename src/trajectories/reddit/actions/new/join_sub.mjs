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

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_join_sub_new', proxy: proxyUrl, persona, targetHost: 'www.reddit.com' });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /reddit\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  // Modern shreddit subreddit join lives at /r/<sub>/. The subreddit header
  // renders <shreddit-subreddit-header-buttons name="<sub>" subreddit-id="t5_..."
  // is-user-logged-in [is-subscribed]>; the is-subscribed boolean attribute
  // flips on subscribe (verified 2026-05-02 via curl: same component on
  // r/CasualConversation showed `is-subscribed` after the legacy join_sub
  // action ran, and was absent on r/AskReddit which the same account had not
  // subscribed to). The inner Join button is rendered client-side via the
  // Web Component upgrade (the SSR HTML shows <shreddit-subreddit-header-buttons
  // ...></shreddit-subreddit-header-buttons> with no children); Playwright's
  // shadow-DOM-piercing locator with `:has-text("Join")` resolves the actual
  // button after the upgrade fires.
  await s.goto(`https://www.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/`);
  checkReachable(s, 'reddit');
  await humanIdlePause('deliberate');
  try { await assertAuthed('reddit', s, { label: 'reddit_join_sub_new' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  const headerBtns = s.page.locator('shreddit-subreddit-header-buttons').first();
  await headerBtns.waitFor({ state: 'attached' });
  const isSubscribed = await headerBtns.evaluate((el) => el.hasAttribute('is-subscribed')).catch(() => false);
  if (isSubscribed) {
    ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already joined r/${SUBREDDIT}`);
  } else {
    const joinBtn = headerBtns.locator('button:has-text("Join")').first();
    await joinBtn.waitFor({ state: 'visible' });
    await joinBtn.scrollIntoViewIfNeeded();
    await humanIdlePause('short');
    await humanClickLocator(s.page, joinBtn);
    // Verification: wait for EITHER the host attribute is-subscribed to flip,
    // OR for the inner button text to flip from "Join" to "Joined". Lit's
    // attribute reflection is sometimes lazy enough to miss a short window;
    // the button-text flip is direct DOM. Either signal is sufficient.
    await s.page.locator('shreddit-subreddit-header-buttons button:has-text("Joined"), shreddit-subreddit-header-buttons[is-subscribed]').first().waitFor({ state: 'attached' });
    ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: joined r/${SUBREDDIT}`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = runRecordingsDir('reddit_join_sub_new'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_join_sub_new', subreddit: SUBREDDIT, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
