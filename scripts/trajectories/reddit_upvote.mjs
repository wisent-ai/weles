import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../dist/human/mouse.js';
import { detectRedditBanSignals } from '../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertAuthed, AuthProbeError } from './_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from './_shared/cookie-freshness.mjs';

const SUBREDDIT = (process.env.SUBREDDIT || 'CasualConversation').replace(/^r\//, '');

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account in DB'); process.exitCode = 1; }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_upvote', proxy: proxyUrl, persona });
// Cookie freshness gate — see _shared/cookie-freshness.mjs.
let _stored;
try {
  const _all = loadFreshCookieJarOrFail(acct, { platform: 'reddit', label: 'reddit_upvote', currentProxyUrl: proxyUrl, currentPersona: persona });
  _stored = _all.filter(c => /reddit\.com/.test(c.domain ?? ''));
  if (!_stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no reddit.com cookies', { platform: 'reddit' });
} catch (jarErr) {
  if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); await s.close().catch(() => {}); process.exitCode = 1; }
  throw jarErr;
}
await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let banSignal = null;
try {
  // Use old.reddit.com — same deterministic vote arrows pattern as
  // reddit/actions/upvote.mjs. Picks first post in the listing.
  await s.goto(`https://old.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/`);
  await humanIdlePause('deliberate');
  // Positive auth probe — see _shared/auth-probe.mjs.
  try { await assertAuthed('reddit', s, { label: 'reddit_upvote' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exitCode = 1; } throw probeErr; }
  const firstThing = s.page.locator('div.thing[data-fullname^="t3_"]').filter({ visible: true }).first();
  await firstThing.waitFor({ state: 'visible' });
  const upArrow = firstThing.locator('div.arrows div.arrow.up:not(.upmod), div.arrows div.arrow.upmod').first();
  if (await firstThing.locator('div.arrows div.arrow.upmod').count()) {
    banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${banSignal?.signal}  PASS: already upvoted`);
  } else {
    await humanClickLocator(s.page, upArrow);
    await firstThing.locator('div.arrows div.arrow.upmod').first().waitFor({ state: 'visible', timeout: 8000 });
    banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${banSignal?.signal}  PASS: upvoted`);
  }
} catch (e) {
  banSignal = e.banSignal ?? await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${banSignal?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = join(process.cwd(), 'recordings', 'reddit_upvote');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_upvote', subreddit: SUBREDDIT, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
