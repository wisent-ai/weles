import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { detectInstagramBanSignals } from '../../../../dist/platforms/instagram/ban_signals.js';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { checkReachable } from '../../_shared/action-runner.mjs';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';

const TARGET_URL = process.env.TARGET_URL || '';

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account'); process.exit(1); }
const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_save', proxy: proxyUrl, persona });
const _stored = (acct.metadata?.cookies ?? []).filter(c => /instagram\.com/.test(c.domain ?? ''));
if (_stored.length) await s.ctx.addCookies(_stored.map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});
let ban = null;
try {
  await s.goto(TARGET_URL || 'https://www.instagram.com/explore/');
  checkReachable(s, 'instagram');
  await s.page.waitForTimeout(3500);
  try { await assertAuthed('instagram', s, { label: 'instagram_save' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }
  if (!/\/p\/|\/reel\//.test(s.page.url())) {
    const thumb = s.page.locator('a[href*="/p/"], a[href*="/reel/"]').filter({ visible: true }).first();
    await thumb.waitFor({ state: 'visible' });
    const href = await thumb.getAttribute('href');
    if (href) {
      const postUrl = href.startsWith('http') ? href : `https://www.instagram.com${href}`;
      await s.goto(postUrl);
      await s.page.waitForTimeout(3000);
    } else {
      await humanClickLocator(s.page, thumb);
      await s.page.waitForTimeout(3000);
    }
  }
  // Bookmark/save: <svg aria-label="Save"> flips to "Remove" once saved.
  // Click the ancestor button/role-button (svg has pointer-events:none).
  const saveSvg = s.page.locator('svg[aria-label="Save"]').filter({ visible: true }).first();
  if (!(await saveSvg.count())) {
    ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: already saved`);
  } else {
    const saveBtn = saveSvg.locator('xpath=ancestor::*[self::button or self::div[@role="button"] or @role="button"][1]').first();
    await saveBtn.scrollIntoViewIfNeeded().catch(() => {});
    await humanClickLocator(s.page, saveBtn);
    await s.page.locator('svg[aria-label="Remove"]').first().waitFor({ state: 'visible' });
    ban = await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
    console.log(`[ban-signal] ${ban?.signal}  PASS: saved`);
  }
} catch (e) {
  ban = e.banSignal ?? await detectInstagramBanSignals(s.page, s.capturedResponses).catch(() => null);
  console.log(`[ban-signal] ${ban?.signal}  FAIL: ${e.message?.slice(0, 200)}`);
  process.exitCode = 1;
} finally {
  if (ban) { try { const dir = join(process.cwd(), 'recordings', 'instagram_save'); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'instagram_save', target_url: TARGET_URL, ...ban, ts: new Date().toISOString() }, null, 2)); } catch {} }
  await s.close();
}
