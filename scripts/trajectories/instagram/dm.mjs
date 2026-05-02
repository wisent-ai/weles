import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../_shared/cookie-freshness.mjs';

const RECIPIENT = process.env.RECIPIENT_HANDLE || 'wisent.ai';
const MESSAGE = process.env.DM_MESSAGE || 'Hello from weles agent';

const acct = await getSocialAccount('instagram');
if (!acct) { console.log('FAIL: no active instagram account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'instagram_dm', proxy: proxyUrl, persona });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'instagram', label: 'instagram_dm', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /instagram\.com/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no instagram.com cookies', { platform: 'instagram' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto('https://www.instagram.com/direct/new/', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(4500);
  if (/\/accounts\/login/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to login (${s.page.url()})`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('instagram', s, { label: 'instagram_dm' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // Some IG cohorts show a Notifications/Updates upsell modal; dismiss
  // opportunistically without blocking if absent.
  await s.page.waitForTimeout(800);
  const notNowSel = 'div[role="dialog"] button:has-text("Not Now"), div[role="dialog"] button:has-text("Not now")';
  const notNowCount = await s.page.locator(notNowSel).filter({ visible: true }).count().catch(() => 0);
  if (notNowCount > 0) await humanClickLocator(s.page, s.page.locator(notNowSel).filter({ visible: true }).first());

  // Recipient picker — input[name="queryBox"] (legacy) or aria/placeholder
  // search input inside the dialog.
  const searchIn = s.page.locator('div[role="dialog"] input[name="queryBox"], div[role="dialog"] input[placeholder*="Search" i], div[role="dialog"] input[aria-label*="Search" i]').filter({ visible: true }).first();
  await searchIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, searchIn);
  await humanType(s.page, RECIPIENT);
  await s.page.waitForTimeout(2500);

  const userRow = s.page.locator(`div[role="dialog"] div[role="button"]:has-text("${RECIPIENT}"), div[role="dialog"] [role="button"] span:has-text("${RECIPIENT}")`).filter({ visible: true }).first();
  await userRow.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, userRow);
  await s.page.waitForTimeout(1200);

  const chatBtn = s.page.locator('div[role="dialog"] button:has-text("Chat"), div[role="dialog"] button:has-text("Next"), div[role="dialog"] [role="button"]:has-text("Chat")').filter({ visible: true }).first();
  await chatBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, chatBtn);
  await s.page.waitForTimeout(3500);

  // Composer is contenteditable div, aria-label="Message". Per
  // feedback_focus_before_type: humanClick the editable BEFORE humanType.
  const composer = s.page.locator('div[contenteditable="true"][aria-label*="Message" i], div[role="textbox"][contenteditable="true"]').filter({ visible: true }).first();
  await composer.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, composer);
  await humanType(s.page, MESSAGE);
  await s.page.waitForTimeout(800);

  const sendSel = 'div[role="button"]:has(svg[aria-label="Send"]), div[role="button"]:has-text("Send"), button:has-text("Send")';
  const sendCount = await s.page.locator(sendSel).filter({ visible: true }).count().catch(() => 0);
  if (sendCount > 0) {
    await humanClickLocator(s.page, s.page.locator(sendSel).filter({ visible: true }).first());
  } else {
    await s.page.keyboard.press('Enter');
  }
  await s.page.waitForTimeout(3000);

  const echoCount = await s.page.locator(`:text("${MESSAGE.slice(0, 60)}")`).filter({ visible: true }).count().catch(() => 0);
  if (!echoCount) { console.log('FAIL: composer typed but message not echoed in conversation pane'); process.exit(1); }
  console.log(`PASS: DM sent to @${RECIPIENT}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
