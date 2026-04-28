import { getSocialAccount, resolveAccountSession } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { detectRedditBanSignals } from '../../dist/platforms/reddit/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// Use old.reddit.com — comment composer is a plain visible <textarea name="text">
// inside a normal form. New reddit.com puts the composer inside <shreddit-composer>'s
// shadow root collapsed at 0×0 until the user clicks "Join the conversation",
// which the agent loop never reliably finds and times out at max-iterations.
const TARGET_URL = process.env.TARGET_URL || 'https://www.reddit.com/r/test/comments/18da1zl/some_test_commands/';
const COMMENT_BODY = process.env.COMMENT_BODY || 'Hello from weles agent';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_comment', proxy: proxyUrl, persona });

// Translate www.reddit.com URLs → old.reddit.com so we can use the plain form.
const oldUrl = TARGET_URL.replace(/^https?:\/\/(www\.)?reddit\.com/, 'https://old.reddit.com');

let banSignal = null;
try {
  const stored = (acct.metadata?.cookies ?? []).filter(c => /reddit\.com/.test(c.domain ?? ''));
  if (stored.length) await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));
  await s.page.goto(oldUrl, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(3000);
  const url = s.page.url();
  if (/\/login/.test(url)) { console.log(`FAIL: cookies stale, redirected to login (${url})`); process.exit(1); }

  // The comment composer is the FIRST textarea[name="text"] on the page —
  // there's one per existing reply box but the top-level reply form is first.
  const ta = s.page.locator('textarea[name="text"]').filter({ visible: true }).first();
  await ta.waitFor({ state: 'visible' });
  await ta.scrollIntoViewIfNeeded();
  await ta.click();
  await ta.pressSequentially(COMMENT_BODY, { delay: 25 });
  await s.page.waitForTimeout(400);
  // Each comment form has a <button class="save"> Save submit. Filter to the
  // form that contains the focused textarea (top-level reply, not a child).
  await s.page.evaluate(() => {
    const ta = document.activeElement; if (!ta) return;
    const form = ta.closest('form'); if (!form) return;
    const btn = form.querySelector('button.save, button[type="submit"]');
    if (btn) btn.click();
  });
  // Wait for the new comment to appear in the thread (Reddit redirects to the
  // permalink of the new comment) — check URL change OR appearance of our
  // posted text in the page.
  let posted = false;
  for (let i = 0; i < 12; i++) {
    await s.page.waitForTimeout(1000);
    const has = await s.page.evaluate((body) => (document.body?.innerText ?? '').includes(body), COMMENT_BODY).catch(() => false);
    if (has) { posted = true; break; }
  }
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (!posted) throw new Error(`comment did not appear after submit — body did not match in page text`);
  console.log(`[ban-signal] ${banSignal?.signal}`);
  console.log(`PASS: commented "${COMMENT_BODY}" on ${oldUrl}`);
} catch (e) {
  banSignal = banSignal ?? await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (banSignal) console.log(`[ban-signal] ${banSignal.signal}`);
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exitCode = 1;
} finally {
  if (banSignal) {
    try {
      const dir = join(process.cwd(), 'recordings', 'reddit_comment');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, ...banSignal, ts: new Date().toISOString() }, null, 2));
    } catch (e) { console.log('[ban-signal] persist err:', e.message); }
  }
  await s.close();
}
