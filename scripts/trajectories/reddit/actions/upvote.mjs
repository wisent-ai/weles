import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { detectRedditBanSignals } from '../../../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';

const SUBREDDIT = (process.env.SUBREDDIT || 'popular').replace(/^r\//, '');
const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_upvote', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /reddit\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  // Use old.reddit.com — the vote arrow is a plain DOM element with stable
  // class names (arrow.up / arrow.upmod) rather than the new-reddit shadow
  // DOM that requires custom-element traversal.
  const baseUrl = TARGET_URL || `https://old.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/`;
  const url = baseUrl.replace(/^https?:\/\/(www\.)?reddit\.com/, 'https://old.reddit.com');
  await s.goto(url);
  checkReachable(s, 'reddit');
  await humanIdlePause('deliberate');
  try { await assertAuthed('reddit', s, { label: 'reddit_upvote' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // First not-yet-upvoted, NOT-archived post arrow. The parent is
  // <div class="midcol unvoted"> (NOT <div class="arrows"> — that selector
  // matches nothing on old.reddit and is why this trajectory previously timed
  // out at the visible-wait below). Archived posts (>6mo old, e.g. stickied
  // welcome threads) carry the .archived class and surface a "This is an
  // archived post. You won't be able to vote or comment." modal on click;
  // skip them in the selector so we never pick an unvotable target.
  // After a successful upvote, the parent flips midcol unvoted → midcol likes
  // and the arrow class flips arrow.up → arrow.upmod.
  // Skip stickied posts entirely — moderators sticky community announcements
  // and welcome threads at the top of every subreddit, and those are usually
  // months-to-years old (archived → unvotable).
  const upArrow = s.page.locator('div.thing:not(.archived):not(.stickied) div.midcol.unvoted div.arrow.up:not(.archived)').first();
  await upArrow.waitFor({ state: 'visible' });
  await upArrow.scrollIntoViewIfNeeded();
  // Identify the picked thing so out-of-band score-delta verification is
  // possible (was the vote actually counted server-side, or shadow-counted
  // locally only). Walks up to the parent div.thing, reads data-fullname.
  const pickedFullname = await upArrow.evaluate((arrow) => {
    let n = arrow;
    for (let i = 0; i < 8 && n; i++) {
      if (n.classList?.contains('thing') && n.getAttribute('data-fullname')) return n.getAttribute('data-fullname');
      n = n.parentElement;
    }
    return null;
  }).catch(() => null);
  // Debug: dump the actually-matched arrow's class + parents so a "wrong
  // pick" failure surfaces actionable info instead of a generic timeout.
  const pickedDebug = await upArrow.evaluate((arrow) => {
    let n = arrow.parentElement; let parents = [];
    for (let i = 0; i < 4 && n; i++) { parents.push(`${n.tagName}.${(n.className||'').slice(0,80)}`); n = n.parentElement; }
    return { arrowCls: arrow.className, parents };
  }).catch(() => null);
  console.log(`[upvote] picked thing data-fullname=${pickedFullname} arrow.cls=${pickedDebug?.arrowCls} parents=${JSON.stringify(pickedDebug?.parents)}`);
  await humanClickLocator(s.page, upArrow);
  // After click, parent class flips: midcol.unvoted → midcol.likes; arrow class
  // flips: arrow.up → arrow.upmod. Scope the wait to the SAME thing we picked
  // (not "any upmod arrow on the page") so a cosmetic match elsewhere can't
  // false-pass the verification.
  if (pickedFullname) {
    await s.page.locator(`div.thing[data-fullname="${pickedFullname}"] div.midcol.likes div.arrow.upmod`).first().waitFor({ state: 'visible' });
  } else {
    await s.page.locator('div.thing div.midcol.likes div.arrow.upmod').first().waitFor({ state: 'visible' });
  }
  ban = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: upvoted ${pickedFullname || ''}`);
} catch (e) {
  ban = e.banSignal ?? await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'reddit_upvote'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'reddit_upvote', subreddit: SUBREDDIT, target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
