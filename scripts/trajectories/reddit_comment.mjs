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
  // Pre-check: read our real handle and probe public about.json. If the
  // account is shadowbanned (about.json → 404), comment will never become
  // publicly visible regardless of where we post it. Bail early with the
  // right signal instead of going through the whole submit-then-verify
  // cycle and reporting rate_limited.
  await s.page.goto('https://old.reddit.com/api/me.json', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(2000);
  const realHandle = await s.page.evaluate(() => { try { return JSON.parse(document.body?.innerText ?? '{}')?.data?.name ?? null; } catch { return null; } });
  if (realHandle) {
    const publicStatus = await fetch(`https://old.reddit.com/user/${encodeURIComponent(realHandle)}/about.json`, { headers: { 'User-Agent': 'weles-verify/1.0' } }).then(r => r.status).catch(() => 0);
    if (publicStatus === 404) {
      banSignal = { signal: 'shadowbanned', healthy: false, details: { real_handle: realHandle, reason: 'about.json 404 — account shadowbanned by Reddit' } };
      throw new Error(`account ${realHandle} is shadowbanned (about.json returns 404) — comment cannot become publicly visible`);
    }
  }
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
  // The optimistic in-page check (body text appearing in page innerText) was
  // returning true even when r/test's spam filter removed the comment server-
  // side a few seconds after submit, so the trajectory printed PASS while
  // the comment never made it to public listing. Two-step verification: (a)
  // wait for body to appear locally (submit confirmed), (b) re-fetch the
  // post listing JSON via fresh request and confirm the comment is in the
  // public tree.
  let postedLocally = false;
  for (let i = 0; i < 12; i++) {
    await s.page.waitForTimeout(1000);
    const has = await s.page.evaluate((body) => (document.body?.innerText ?? '').includes(body), COMMENT_BODY).catch(() => false);
    if (has) { postedLocally = true; break; }
  }
  banSignal = await detectRedditBanSignals(s.page, s.capturedResponses).catch(() => null);
  if (!postedLocally) throw new Error(`submit did not confirm — body did not appear in page text`);
  // Verify public visibility — fetch the post.json and walk for our body.
  // Subreddit spam filters / rate limits can remove the comment within a few
  // seconds of submit; without this re-check we'd PASS on a removed comment.
  const jsonUrl = oldUrl.replace(/\/$/, '') + '.json?limit=500&sort=new';
  let publiclyVisible = false;
  for (let attempt = 0; attempt < 4 && !publiclyVisible; attempt++) {
    await s.page.waitForTimeout(3000);
    try {
      const r = await fetch(jsonUrl, { headers: { 'User-Agent': 'weles-verify/1.0' } });
      const txt = await r.text();
      if (txt.includes(COMMENT_BODY)) publiclyVisible = true;
    } catch { /* retry */ }
  }
  // Distinguish subreddit auto-filter (rate_limited, retryable on different
  // sub) from account-level shadowban (permanent). Reddit returns 404 on
  // /user/<handle>/about.json when the account is shadowbanned. Probe the
  // me.json from the session to read our real handle, then check public
  // visibility — 404 means shadowbanned account.
  if (!publiclyVisible) {
    let realHandle = null;
    try {
      const me = await s.page.evaluate(async () => {
        const r = await fetch('/api/me.json', { credentials: 'include' });
        const j = await r.json().catch(() => null);
        return j?.data?.name ?? null;
      });
      realHandle = me;
    } catch { /* skip */ }
    if (realHandle) {
      const publicCheck = await fetch(`https://old.reddit.com/user/${encodeURIComponent(realHandle)}/about.json`, { headers: { 'User-Agent': 'weles-verify/1.0' } }).then(r => r.status).catch(() => 0);
      if (publicCheck === 404) banSignal = { signal: 'shadowbanned', healthy: false, details: { real_handle: realHandle, reason: 'about.json 404 — account shadowbanned by Reddit' } };
    }
    banSignal = banSignal ?? { signal: 'rate_limited', healthy: false };
  }
  console.log(`[ban-signal] ${banSignal?.signal}`);
  if (!publiclyVisible) throw new Error(`comment not publicly visible after 12s — ${banSignal.signal === 'shadowbanned' ? 'account shadowbanned by Reddit' : 'subreddit filter removed it'}`);
  console.log(`PASS: commented "${COMMENT_BODY}" on ${oldUrl} (verified public)`);
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
