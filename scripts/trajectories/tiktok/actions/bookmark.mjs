import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectTikTokBanSignals } from '../../../../dist/platforms/tiktok/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_bookmark', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /tiktok\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  await s.goto(TARGET_URL || 'https://www.tiktok.com/foryou');
  checkReachable(s, 'tiktok');
  await s.page.waitForTimeout(4000);
  // Bookmark/favorite button: data-e2e="video-save" on the right-hand
  // action rail. aria-pressed flips to "true" after a successful save.
  const saveBtn = s.page.locator('button[data-e2e="video-save"], button:has([data-e2e="video-save"])').filter({ visible: true }).first();
  await saveBtn.waitFor({ state: 'visible' });
  await saveBtn.scrollIntoViewIfNeeded();
  const before = await saveBtn.getAttribute('aria-pressed').catch(() => null);
  if (before === 'true') {
    ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already saved`);
  } else {
    await humanClickLocator(s.page, saveBtn);
    await s.page.waitForFunction(
      (el) => el?.getAttribute('aria-pressed') === 'true',
      await saveBtn.elementHandle(),
    );
    ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: bookmarked`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'tiktok_bookmark'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'tiktok_bookmark', target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
