import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { detectTwitterBanSignals } from '../../../../dist/platforms/twitter/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';

const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_bookmark', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /x\.com|twitter\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  await s.goto(TARGET_URL || 'https://x.com/home');
  checkReachable(s, 'twitter');
  await humanIdlePause('deliberate');
  // Deterministic: data-testid="bookmark" is the un-bookmarked state;
  // post-click the same testid flips to "removeBookmark".
  const bookmarkBtn = s.page.locator('[data-testid="bookmark"]').filter({ visible: true }).first();
  await bookmarkBtn.waitFor({ state: 'visible' });
  await bookmarkBtn.scrollIntoViewIfNeeded();
  await humanClickLocator(s.page, bookmarkBtn);
  await s.page.locator('[data-testid="removeBookmark"]').first().waitFor({ state: 'visible' });
  ban = await detectTwitterBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: bookmarked`);
} catch (e) {
  ban = e.banSignal ?? await detectTwitterBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'twitter_bookmark'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'twitter_bookmark', target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
