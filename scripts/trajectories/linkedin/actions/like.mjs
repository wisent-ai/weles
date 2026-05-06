import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectLinkedInBanSignals } from '../../../../dist/platforms/linkedin/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { reloginLinkedinInline } from '../../_shared/linkedin/relogin.mjs';

const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'linkedin_like', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /linkedin\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  // s.goto wraps page.goto with waitCloudflare — but WSession's context
  // sets defaultNavigationTimeout(0) so the underlying goto hangs forever
  // when the page never reaches domcontentloaded (LinkedIn /feed/ on stale
  // cookies redirects through auth wall and stalls). Use page.goto with an
  // explicit 45s timeout; LinkedIn doesn't use Cloudflare so the
  // waitCloudflare DOM probe is unnecessary on this surface.
  // Auth gate: navigate + checkReachable + assertAuthed. Any of these can
  // throw auth_wall (cookies stale because the residential sticky changed
  // exit IP since they were minted). On auth_wall, do an inline relogin on
  // the SAME WSession so the new li_at is bound to the current sticky's
  // exit IP; retry the whole gate once.
  let authed = false;
  for (let attempt = 0; attempt < 2 && !authed; attempt++) {
    try {
      await s.page.goto(TARGET_URL || 'https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded', timeout: 45000 });
      checkReachable(s, 'linkedin');
      await s.page.waitForTimeout(3500);
      await assertAuthed('linkedin', s, { label: 'linkedin_like' });
      authed = true;
    } catch (gateErr) {
      const isAuthWall = gateErr instanceof AuthProbeError || /auth_wall/.test(gateErr.message ?? '');
      if (!isAuthWall || attempt > 0) throw gateErr;
      console.log(`[linkedin_like] auth_wall on attempt ${attempt + 1} — running inline relogin on same session`);
      const r = await reloginLinkedinInline(s, acct);
      if (!r.ok) { console.log(`FAIL: inline relogin failed: ${r.reason}`); await markCookiesStale(acct.id); process.exit(1); }
    }
  }
  // LinkedIn's like button is a <button aria-label="React Like"> that flips
  // aria-pressed false→true on click. 2026-05-06: the legacy post-container
  // selectors (.feed-shared-update-v2, .fie-impression-container,
  // [data-id^="urn:li:activity"]) are gone in the new design system, so
  // target the first React-Like button on the page directly. The aria-label
  // is semantic and stable; comment-level likes have a different
  // aria-label ("Like this comment") so the React-Like prefix already
  // excludes them.
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
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'linkedin_like'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'linkedin_like', target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
