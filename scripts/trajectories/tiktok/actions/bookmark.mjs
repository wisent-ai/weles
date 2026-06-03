import { getSocialAccount, resolveAccountSession } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { detectTikTokBanSignals } from '../../../../dist/platforms/tiktok/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/cookie-freshness.mjs';
import { markCookiesStale } from '../../../../dist/utils/credentials.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';

const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_bookmark', proxy: proxyUrl, persona });
// Cookie freshness gate — see _shared/cookie-freshness.mjs.
let _stored;
try {
  const _all = loadFreshCookieJarOrFail(acct, { platform: 'tiktok', label: 'tiktok_bookmark', currentProxyUrl: proxyUrl, currentPersona: persona });
  _stored = _all.filter(c => /tiktok\.com/.test(c.domain ?? ''));
  if (!_stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no tiktok.com cookies', { platform: 'tiktok' });
} catch (jarErr) {
  if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); await s.close().catch(() => {}); process.exit(1); }
  throw jarErr;
}
await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  await s.goto(TARGET_URL || 'https://www.tiktok.com/foryou');
  checkReachable(s, 'tiktok');
  await humanIdlePause('deliberate');
  try { await assertAuthed('tiktok', s, { label: 'tiktok_bookmark' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  // Bookmark/favorite button: data-e2e="video-save" on the right-hand
  // action rail. aria-pressed flips to "true" after a successful save.
  // 2026-05-02: TikTok video-page DOM uses aria-label-only buttons for the
  // right-rail action items (no data-e2e). Probe showed:
  //   <button aria-label="Add to Favourites 218 added to Favourites" class="css-...ButtonActionItem ...">
  // Match by aria-label substring; keep older data-e2e selectors for the
  // foryou rail variant.
  const saveBtn = s.page.locator('button[data-e2e="video-save"], button[data-e2e="favorite-icon"], button[data-e2e="browse-favorite-icon"], button[aria-label*="favourite" i], button[aria-label*="favorite" i]').filter({ visible: true }).first();
  await saveBtn.waitFor({ state: 'visible' });
  await saveBtn.scrollIntoViewIfNeeded();
  // Modern video-page DOM doesn't toggle aria-pressed; aria-label changes
  // from "Add to Favourites N added to Favourites" to "Added to Favourites
  // N added to Favourites". Read aria-label state both before and after.
  const beforeLabel = await saveBtn.getAttribute('aria-label').catch(() => '') || '';
  const beforePressed = await saveBtn.getAttribute('aria-pressed').catch(() => null);
  const alreadySaved = beforePressed === 'true' || /^Added to/i.test(beforeLabel);
  if (alreadySaved) {
    ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already saved`);
  } else {
    await humanClickLocator(s.page, saveBtn);
    await s.page.waitForFunction(
      ({ el, beforeLabel }) => {
        if (!el) return false;
        if (el.getAttribute('aria-pressed') === 'true') return true;
        const lbl = el.getAttribute('aria-label') || '';
        return /^Added to/i.test(lbl) || (lbl !== beforeLabel && /favou?rit/i.test(lbl));
      },
      { el: await saveBtn.elementHandle(), beforeLabel },
    );
    ban = await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: bookmarked`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectTikTokBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = runRecordingsDir('tiktok_bookmark'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'tiktok_bookmark', target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
