import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { detectLinkedInBanSignals } from '../../../../dist/platforms/linkedin/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { openLinkedinAuthed } from '../../_shared/linkedin/authed_open.mjs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

// The page the like lands on is the caller's; no feed is assumed.
const TARGET_URL = process.env.TARGET_URL;
if (!TARGET_URL) { console.log('FAIL: TARGET_URL env var required: the LinkedIn page the like lands on'); process.exit(1); }

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'linkedin_like', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /linkedin\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  // Auth gate: navigate + checkReachable + assertAuthed. Any of these can
  // throw auth_wall (cookies stale because the residential sticky changed
  // exit IP since they were minted); openLinkedinAuthed then signs in again
  // on the SAME WSession so the new li_at is bound to the current sticky's
  // exit IP, and opens the page once more.
  const opened = await openLinkedinAuthed(s, acct, 'linkedin_like', async () => {
    await s.page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });
    checkReachable(s, 'linkedin');
    await humanIdlePause('deliberate');
  });
  if (!opened.ok) { console.log(`FAIL: inline relogin failed: ${opened.reason}`); await markCookiesStale(acct.id); process.exit(1); }
  // LinkedIn's like button is a <button aria-label="React Like"> that flips
  // aria-pressed false→true on click. The React-Like label excludes
  // comment-level actions labeled "Like this comment".
  const likeBtn = s.page.locator('button[aria-label*="React Like" i]:not([aria-pressed="true"])').first();
  if (!(await likeBtn.count())) {
    // Already liked OR no posts on the page — idempotent PASS-or-noop.
    const anyLiked = await s.page.locator('button[aria-label*="React Like" i][aria-pressed="true"]').count();
    ban = await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: ${anyLiked ? 'already liked' : 'no_likeable_posts_on_page'}`);
  } else {
    await likeBtn.scrollIntoViewIfNeeded().catch(() => {});
    await humanClickLocator(s.page, likeBtn);
    await s.page.locator('button[aria-label*="React Like" i][aria-pressed="true"]').first().waitFor({ state: 'visible' });
    ban = await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: liked`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = runRecordingsDir('linkedin_like'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'linkedin_like', target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
