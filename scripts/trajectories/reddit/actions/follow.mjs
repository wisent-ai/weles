import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectRedditBanSignals } from '../../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';

const TARGET_USER = (process.env.TARGET_USER || '').replace(/^u\//, '').replace(/^\/u\//, '');
const SUBREDDIT   = (process.env.SUBREDDIT   || 'popular').replace(/^r\//, '');

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_follow', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /reddit\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  let author = TARGET_USER;
  if (!author) {
    await s.goto('https://old.reddit.com/');
    checkReachable(s, 'reddit');
    const data = await s.page.evaluate(async (u) => {
      try { const r = await fetch(u, { credentials: 'include', headers: { 'Accept': 'application/json' } }); if (!r.ok) return null; return await r.json(); } catch { return null; }
    }, `https://old.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/new/.json?limit=50&raw_json=1`).catch(() => null);
    const pick = (data?.data?.children ?? []).map(c => c.data).filter(p => p && p.author && p.author !== '[deleted]' && !/^AutoModerator$/i.test(p.author))[0];
    if (pick) author = pick.author;
    if (!author) throw new Error('no author found to follow');
  }
  // Reddit's "follow user" is implemented as "subscribe to r/u_USERNAME"
  // (the user's profile subreddit) — old.reddit.com surfaces that same
  // .fancy-toggle-button.add → .remove pattern as join_sub. Visiting the
  // u_ subreddit directly avoids new-reddit shadow DOM entirely.
  await s.goto(`https://old.reddit.com/r/u_${encodeURIComponent(author)}/`);
  checkReachable(s, 'reddit');
  try { await assertAuthed('reddit', s, { label: 'reddit_follow' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  if (await s.page.locator('a.fancy-toggle-button.remove, a.toggle-button.active').first().isVisible().catch(() => false)) {
    ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already following u/${author}`);
  } else {
    const joinBtn = s.page.locator('a.fancy-toggle-button.add, a:has-text("subscribe")').filter({ visible: true }).first();
    await joinBtn.waitFor({ state: 'visible' });
    await joinBtn.scrollIntoViewIfNeeded();
    await humanClickLocator(s.page, joinBtn);
    await s.page.locator('a.fancy-toggle-button.remove, a.toggle-button.active').first().waitFor({ state: 'visible' });
    ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: now following u/${author}`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'reddit_follow'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_follow', target_user: TARGET_USER, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
