import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { detectTwitterBanSignals } from '../../../../dist/platforms/twitter/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

const TARGET_URL  = process.env.TARGET_URL || '';
const TARGET_USER = (process.env.TARGET_USER || '').replace(/^@/, '');
const SEARCH_QUERY = (process.env.SEARCH_QUERY || '').replace(/^#/, '');

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_like', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /x\.com|twitter\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  let url;
  if (TARGET_URL) url = TARGET_URL;
  else if (TARGET_USER) url = `https://x.com/${encodeURIComponent(TARGET_USER)}`;
  else if (SEARCH_QUERY) url = `https://x.com/hashtag/${encodeURIComponent(SEARCH_QUERY)}`;
  else url = 'https://x.com/home';
  await s.goto(url);
  checkReachable(s, 'twitter');
  await humanIdlePause('deliberate');
  // Deterministic: data-testid="like" is the unliked button (heart icon in
  // the tweet action row); after a successful like the same button switches
  // to data-testid="unlike". Click the first visible like, then verify the
  // unlike state appeared.
  const likeBtn = s.page.locator('[data-testid="like"]').filter({ visible: true }).first();
  await likeBtn.waitFor({ state: 'visible' });
  await likeBtn.scrollIntoViewIfNeeded();
  await humanClickLocator(s.page, likeBtn);
  await s.page.locator('[data-testid="unlike"]').first().waitFor({ state: 'visible' });
  ban = await detectTwitterBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: liked`);
} catch (e) {
  ban = e.banSignal ?? await detectTwitterBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = runRecordingsDir('twitter_like'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'twitter_like', target_url: TARGET_URL, target_user: TARGET_USER, search_query: SEARCH_QUERY, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
