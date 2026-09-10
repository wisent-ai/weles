import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/cookie-freshness.mjs';

const RECIPIENT = (process.env.RECIPIENT_HANDLE || 'wisent.ai').replace(/^@/, '');
const MESSAGE = process.env.DM_MESSAGE || 'Hello from weles agent';

const acct = await getSocialAccount('tiktok');
if (!acct) { console.log('FAIL: no active tiktok account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'tiktok_dm', proxy: proxyUrl, persona });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'tiktok', label: 'tiktok_dm', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /tiktok\.com/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no tiktok.com cookies', { platform: 'tiktok' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto('https://www.tiktok.com/messages', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  if (/\/login(\/|$)/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to login (${s.page.url()})`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('tiktok', s, { label: 'tiktok_dm' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  const newMsgBtn = s.page.locator('[data-e2e="chat-create-new"], button[aria-label*="New message" i], div[role="button"]:has-text("New message"), button:has-text("New message")').filter({ visible: true }).first();
  await newMsgBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, newMsgBtn);
  await humanIdlePause('short');

  const searchIn = s.page.locator('input[data-e2e="chat-create-new-search"], input[placeholder*="Search" i], input[aria-label*="Search" i]').filter({ visible: true }).first();
  await searchIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, searchIn);
  await humanType(s.page, RECIPIENT);
  await humanIdlePause('deliberate');

  const userRow = s.page.locator(`[data-e2e*="search-user"]:has-text("${RECIPIENT}"), div[role="button"]:has-text("${RECIPIENT}"), li:has-text("${RECIPIENT}")`).filter({ visible: true }).first();
  await userRow.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, userRow);
  await humanIdlePause('short');

  // Some flows show a "Next"/"Start chat" confirm — opportunistic.
  await humanIdlePause('short');
  const nextSel = 'button:has-text("Next"), button:has-text("Start chat"), [role="button"]:has-text("Next")';
  const nextCount = await s.page.locator(nextSel).filter({ visible: true }).count().catch(() => 0);
  if (nextCount > 0) {
    await humanClickLocator(s.page, s.page.locator(nextSel).filter({ visible: true }).first());
    await humanIdlePause('deliberate');
  }

  // Recipient may have DMs restricted (followers-only) → composer never
  // mounts. Surface as a structured FAIL instead of waiting on default
  // 30s waitFor.
  await humanIdlePause('short');
  const composerSel = '[data-e2e="message-input-textarea"], div[contenteditable="true"][role="textbox"], textarea[data-e2e*="message-input"]';
  const composerCount = await s.page.locator(composerSel).filter({ visible: true }).count().catch(() => 0);
  if (!composerCount) {
    const restrictNoteCount = await s.page.locator(':text("can\'t send"), :text("DMs are off"), :text("only people you follow")').count().catch(() => 0);
    console.log(restrictNoteCount > 0 ? 'FAIL: recipient does not accept DMs (privacy restriction)' : 'FAIL: composer not visible after recipient selected');
    process.exit(1);
  }
  const composer = s.page.locator(composerSel).filter({ visible: true }).first();
  await humanClickLocator(s.page, composer);
  await humanType(s.page, MESSAGE);
  await humanIdlePause('short');

  const sendSel = '[data-e2e="message-send"], button[aria-label*="Send" i], div[role="button"]:has-text("Send")';
  const sendCount = await s.page.locator(sendSel).filter({ visible: true }).count().catch(() => 0);
  if (sendCount > 0) {
    await humanClickLocator(s.page, s.page.locator(sendSel).filter({ visible: true }).first());
  } else {
    await s.page.keyboard.press('Enter');
  }
  await humanIdlePause('deliberate');

  const echoCount = await s.page.locator(`:text("${MESSAGE.slice(0, 60)}")`).filter({ visible: true }).count().catch(() => 0);
  if (!echoCount) { console.log('FAIL: composer typed but message not echoed in conversation pane'); process.exit(1); }
  console.log(`PASS: DM sent to @${RECIPIENT}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
