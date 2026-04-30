import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectLinkedInBanSignals } from '../../../../dist/platforms/linkedin/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'linkedin_like', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /linkedin\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  await s.goto(TARGET_URL || 'https://www.linkedin.com/feed/');
  checkReachable(s, 'linkedin');
  await s.page.waitForTimeout(3500);
  // LinkedIn's like button is a <button aria-label="React Like"> that flips
  // aria-pressed false→true on click. Scope to the first feed post container
  // so we don't accidentally tap a comment-level like.
  const post = s.page.locator('div.feed-shared-update-v2, div.fie-impression-container, [data-id^="urn:li:activity"]').first();
  await post.waitFor({ state: 'visible' });
  await post.scrollIntoViewIfNeeded().catch(() => {});
  const likeBtn = post.locator('button[aria-label*="React Like" i]:not([aria-pressed="true"])').first();
  if (!(await likeBtn.count())) {
    // Already liked — idempotent PASS
    ban = await detectLinkedInBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already liked`);
  } else {
    await likeBtn.scrollIntoViewIfNeeded().catch(() => {});
    await humanClickLocator(s.page, likeBtn);
    await post.locator('button[aria-label*="React Like" i][aria-pressed="true"]').first().waitFor({ state: 'visible' });
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
