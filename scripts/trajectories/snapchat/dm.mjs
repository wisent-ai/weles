import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../_shared/cookie-freshness.mjs';

const RECIPIENT = (process.env.RECIPIENT_HANDLE || 'team.snapchat').replace(/^@/, '');
const MESSAGE = process.env.DM_MESSAGE || 'Hello from weles agent';

const acct = await getSocialAccount('snapchat');
if (!acct) { console.log('FAIL: no active snapchat account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username} → @${RECIPIENT}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'snapchat_dm', proxy: proxyUrl, persona });

try {
  let stored = [];
  try {
    stored = loadFreshCookieJarOrFail(acct, { platform: 'snapchat', label: 'snapchat_dm', currentProxyUrl: proxyUrl, currentPersona: persona });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.filter(c => c?.name && c?.value && (c.domain || c.url)).map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});

  await s.page.goto('https://web.snapchat.com/', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(5500);
  if (/login|signup|accounts\.snapchat\.com/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to ${s.page.url()}`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('snapchat', s, { label: 'snapchat_dm' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  const composeBtn = s.page.locator('button[aria-label="Compose Chat"], button[aria-label*="New Chat" i], button[aria-label*="Compose" i]').filter({ visible: true }).first();
  await composeBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, composeBtn);
  await s.page.waitForTimeout(1500);

  const searchIn = s.page.locator('div[role="textbox"][contenteditable="true"], input[type="search"], input[aria-label*="Search" i], input[placeholder*="Search" i]').filter({ visible: true }).first();
  await searchIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, searchIn);
  await humanType(s.page, RECIPIENT);
  await s.page.waitForTimeout(2500);

  const userRow = s.page.locator(`[role="option"]:has-text("${RECIPIENT}"), [role="button"]:has-text("${RECIPIENT}"), li:has-text("${RECIPIENT}")`).filter({ visible: true }).first();
  await userRow.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, userRow);
  await s.page.waitForTimeout(1200);

  await s.page.waitForTimeout(400);
  const chatBtnSel = 'button:has-text("Chat"), button:has-text("Next"), [role="button"]:has-text("Chat")';
  const chatBtnCount = await s.page.locator(chatBtnSel).filter({ visible: true }).count().catch(() => 0);
  if (chatBtnCount > 0) {
    await humanClickLocator(s.page, s.page.locator(chatBtnSel).filter({ visible: true }).first());
    await s.page.waitForTimeout(2000);
  }

  const composer = s.page.locator('div[role="textbox"][contenteditable="true"][aria-label*="message" i], div[role="textbox"][contenteditable="true"]').filter({ visible: true }).last();
  await composer.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, composer);
  await humanType(s.page, MESSAGE);
  await s.page.waitForTimeout(600);

  const sendSel = 'button[aria-label*="Send" i], div[role="button"][aria-label*="Send" i]';
  const sendCount = await s.page.locator(sendSel).filter({ visible: true }).count().catch(() => 0);
  if (sendCount > 0) {
    await humanClickLocator(s.page, s.page.locator(sendSel).filter({ visible: true }).first());
  } else {
    await s.page.keyboard.press('Enter');
  }
  await s.page.waitForTimeout(3000);

  const echoCount = await s.page.locator(`:text("${MESSAGE.slice(0, 60)}")`).filter({ visible: true }).count().catch(() => 0);
  if (!echoCount) { console.log('FAIL: composer typed but message not echoed in chat'); process.exit(1); }
  console.log(`PASS: DM sent to @${RECIPIENT}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
