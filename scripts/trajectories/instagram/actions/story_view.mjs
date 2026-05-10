import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { detectInstagramBanSignals } from '../../../../dist/platforms/instagram/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_story_view', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /instagram\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  await s.goto('https://www.instagram.com/');
  checkReachable(s, 'instagram');
  await humanIdlePause('deliberate');
  try { await assertAuthed('instagram', s, { label: 'instagram_story_view' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // Story tray entries are <li role="menuitem" tabindex="0"> with anchored
  // story-ring image. Click the first one to enter the stories viewer.
  // Once inside, /stories/{user}/{id} is the URL — auto-advance handles the
  // rest. Wait ~15s then close via Esc (no need to find X).
  const story = s.page.locator('li[role="menuitem"], button[aria-label^="Story by"], div[role="menuitem"]:has(canvas), a[href^="/stories/"]').filter({ visible: true }).first();
  if (!(await story.count())) throw new Error('no stories in tray');
  await story.scrollIntoViewIfNeeded().catch(() => {});
  await humanClickLocator(s.page, story);
  await s.page.waitForFunction(() => /\/stories\//.test(location.pathname), { timeout: 8000 });
  // Dwell ~15s so 3+ stories auto-advance and register as views.
  for (let i = 0; i < 15; i++) await humanIdlePause('short');
  await s.page.keyboard.press('Escape').catch(() => {});
  await humanIdlePause('short');
  ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  PASS: viewed`);
} catch (e) {
  ban = e.banSignal ?? await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'instagram_story_view'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'instagram_story_view', ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
