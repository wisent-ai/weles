import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { detectRedditBanSignals } from '../../../../dist/platforms/reddit/ban_signals.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanIdlePause, humanScroll, humanClickLocator } from '../../../../dist/human/mouse.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { DEFER_VERIFY_MS } from './comment/steps/constants.mjs';
import { restoreRedditSession } from './comment/steps/session_restore.mjs';
import { readOwnHandle, resolveTargetPost } from './comment/steps/reddit_json.mjs';
import { classifyInvisibleComment, confirmBlockingSignal, pollPublicVisibility } from './comment/steps/visibility.mjs';
import { deferredCleanSessionVerify } from './comment/steps/deferred_verify.mjs';

// Use old.reddit.com — comment composer is a plain visible <textarea name="text">
// inside a normal form. New reddit.com puts the composer inside <shreddit-composer>'s
// shadow root collapsed at 0×0 until the user clicks "Join the conversation",
// which the agent loop never reliably finds and times out at max-iterations.
//
// Default target: r/CasualConversation (newbie-tolerant, no karma gate, light
// AutoMod). Previous default r/test produced false-positive shadowban verdicts:
// r/test's auto-mod removes new-account comments quickly, which our verifier
// reads as shadowban. CasualConversation accepts comments from <24h-old
// accounts and has steady comment volume.
const TARGET_URL = process.env.TARGET_URL || 'https://www.reddit.com/r/CasualConversation/new/';
// Comment body needs to be innocuous and topic-appropriate. The previous
// default "Hello from weles agent" literally announced automation —
// Reddit's content classifier flags this and shadowbans the account
// within minutes of submit. Generic acknowledgement-style text is normal
// and won't flag.
const COMMENT_BODY = process.env.COMMENT_BODY || 'thanks for sharing';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account in Skarbiec'); process.exitCode = 1; }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_comment', proxy: proxyUrl, persona });

// Translate www.reddit.com URLs → old.reddit.com so we can use the plain form.
const oldUrl = TARGET_URL.replace(/^https?:\/\/(www\.)?reddit\.com/, 'https://old.reddit.com');

/** Our real handle for the post-submit verification, or false when Reddit gives none. */
async function readHandle() {
  // The about.json 404 pre-check that used to live here has a documented
  // false-positive history: Reddit's edge tier returns 404 for about.json
  // requests routed through certain residential proxy IPs even when the
  // account is healthy and the comment becomes publicly visible (verified
  // 2026-04-29 with zanewest5941). The reliable shadowban signal is the
  // post-submit permalink JSON check, which uses the same fetch path as the
  // comment submission, so only the handle is read here.
  try {
    return await readOwnHandle(s.page);
  } catch (e) {
    console.log(`[trajectory] /api/me.json unreadable: ${e.message?.slice(0, 120)}`);
    return false;
  }
}

/** Type the comment into the first composer and submit it through real pointer events. */
async function writeComment() {
  // Pre-comment dwell — scroll the post body and a few existing comments
  // before opening the composer. Reddit's behavioral classifier scores the
  // user's pre-action telemetry as part of the post-submit shadowban gate.
  await humanIdlePause('deliberate');
  await humanScroll(s.page, 1200, 3).catch((e) => console.log(`[trajectory] pre-comment scroll: ${e.message?.slice(0, 80)}`));
  await humanIdlePause('short');
  // The comment composer is the FIRST textarea[name="text"] on the page —
  // there's one per existing reply box but the top-level reply form is first.
  const ta = s.page.locator('textarea[name="text"]').filter({ visible: true }).first();
  await ta.waitFor({ state: 'visible' });
  // Humanized click into textarea — moves cursor via Bezier path, lands at
  // a randomized offset inside the box, then clicks: the pre-click pointer
  // trajectory is a behavioral signal Reddit's anti-bot reads alongside the
  // submit click.
  await humanClickLocator(s.page, ta);
  await humanIdlePause('short');
  await ta.focus();
  await humanType(s.page, COMMENT_BODY);
  await humanIdlePause('short');
  // CRITICAL: the submit must be a real click. A synthetic JS click produces
  // ZERO mouse events; Reddit's behavioral classifier tracks the
  // pointermove/mouseenter/mouseover/pointerdown/mouseup/click sequence, and
  // an action-submit click with no preceding pointer activity is the
  // textbook bot signal. Verified 2026-04-29: with an evaluate-click, even
  // fresh accounts on residential IPs got hard-banned within minutes. So the
  // submit button is located via Playwright by walking up from the textarea
  // and clicked through humanClickLocator (full Bezier trajectory, real
  // mousedown/up via CDP).
  const submitBtn = ta.locator('xpath=ancestor::form[1]').locator('button.save, button[type="submit"]').first();
  await submitBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, submitBtn);
}

/**
 * Wait for the comment to appear in our own page. Returns the authored
 * comment's id, 'POSTED_NO_ID' when the body is on the page but the node was
 * not found, or false when it never appeared.
 */
async function waitForLocalPost() {
  for (let i = 0; i < 12; i++) {
    await humanIdlePause('short');
    const found = await s.page.evaluate((body) => {
      const text = document.body?.innerText ?? '';
      if (!text.includes(body)) return false;
      // Find the comment node we just authored — old.reddit renders
      // <div id="thing_t1_<id>" class="thing id-t1_<id> ..."> for each comment.
      const things = document.querySelectorAll('div[id^="thing_t1_"]');
      for (const el of things) {
        const md = el.querySelector('.usertext-body, .md');
        if (md && md.textContent && md.textContent.includes(body)) {
          const m = el.id.match(/^thing_t1_([a-z0-9]+)$/);
          if (m) return m[1];
        }
      }
      return 'POSTED_NO_ID';
    }, COMMENT_BODY).catch(() => false);
    if (found) return found;
  }
  return false;
}

let banSignal = false;
try {
  await restoreRedditSession(s, acct);
  await s.page.goto('https://old.reddit.com/api/me.json', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  const handle = await readHandle();
  if (handle) console.log(`[trajectory] real handle: ${handle}`);

  const resolvedOldUrl = await resolveTargetPost(s.page, oldUrl);
  await s.page.goto(resolvedOldUrl, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  const url = s.page.url();
  if (/\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); process.exitCode = 1; }

  await writeComment();
  // The optimistic in-page check (body text appearing in page innerText) was
  // returning true even when a spam filter removed the comment server-side a
  // few seconds after submit, so the trajectory printed PASS while the comment
  // never made it to public listing. Two-step verification: (a) wait for the
  // body to appear locally (submit confirmed), (b) re-fetch the permalink JSON
  // and confirm the comment is in the public tree.
  const found = await waitForLocalPost();
  const postedCommentId = found && found !== 'POSTED_NO_ID' ? found : false;
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => false);
  if (!found) throw new Error(`submit did not confirm — body did not appear in page text`);
  banSignal = await confirmBlockingSignal(s, banSignal, COMMENT_BODY);

  const visibility = await pollPublicVisibility(s, { baseUrl: oldUrl.replace(/\/$/, ''), postedCommentId, handle, body: COMMENT_BODY });
  if (!visibility.publiclyVisible) {
    banSignal = await classifyInvisibleComment(s, banSignal, COMMENT_BODY);
    console.log(`[ban-signal] ${banSignal.signal}`);
    throw new Error(`comment not publicly visible — ${banSignal.signal} (${banSignal.details?.reason ?? 'no detail'})`);
  }
  console.log('[ban-signal] healthy');
  console.log(`PASS: commented "${COMMENT_BODY}" on ${resolvedOldUrl} (verified public, in-session)`);

  if (DEFER_VERIFY_MS > 0) await deferredCleanSessionVerify({ acct, resolvedOldUrl, postedCommentId, handle });
} catch (e) {
  if (e.banSignal) banSignal = e.banSignal;
  if (!banSignal) banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => false);
  if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = runRecordingsDir('reddit_comment');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
