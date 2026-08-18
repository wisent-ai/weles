import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../_shared/cookie-freshness.mjs';

// Distinct from discord/organic_message.mjs (which posts into a guild channel
// at SERVER_CHANNEL_PATH). This one is a real 1:1 DM via the Cmd/Ctrl+K
// quick-switcher → search by username → recipient row → composer.
const RECIPIENT = (process.env.RECIPIENT_HANDLE || '').replace(/^@/, '');
const MESSAGE = process.env.DM_MESSAGE || 'Hello from weles agent';
if (!RECIPIENT) { console.log('FAIL: RECIPIENT_HANDLE env required (Discord username, no @)'); process.exit(1); }

const acct = await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no active discord account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username} → @${RECIPIENT}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_dm', proxy: proxyUrl, persona });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'discord', label: 'discord_dm', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /discord\.com/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no discord.com cookies', { platform: 'discord' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto('https://discord.com/channels/@me', { waitUntil: 'domcontentloaded' });
  await humanIdlePause('long');
  if (/\/login/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to login (${s.page.url()})`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('discord', s, { label: 'discord_dm' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // Quick-switcher (Cmd/Ctrl+K) — most reliable cross-cohort path to a 1:1
  // DM. Searches DMs + friends + guilds.
  const isMac = process.platform === 'darwin';
  await s.page.keyboard.press(isMac ? 'Meta+K' : 'Control+K');
  await humanIdlePause('short');

  // If quick-switcher didn't open, click the "Find or start a conversation"
  // pill above the DM list as the alternate entry point.
  const switcherSel = 'input[placeholder*="Where would you like to go" i], div[role="combobox"] input, input[role="combobox"]';
  let switcherCount = await s.page.locator(switcherSel).filter({ visible: true }).count().catch(() => 0);
  if (!switcherCount) {
    const findPill = s.page.locator('button:has-text("Find or start a conversation"), [role="button"]:has-text("Find or start a conversation")').filter({ visible: true }).first();
    await findPill.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, findPill);
    await humanIdlePause('short');
  }
  const queryIn = s.page.locator(switcherSel).filter({ visible: true }).first();
  await queryIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, queryIn);
  await humanType(s.page, RECIPIENT);
  await humanIdlePause('deliberate');

  const userRow = s.page.locator(`[role="listbox"] [role="option"]:has-text("${RECIPIENT}")`).filter({ visible: true }).first();
  await userRow.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, userRow);
  await humanIdlePause('deliberate');

  // Composer: contenteditable slate editor.
  await humanIdlePause('short');
  const composerSel = 'div[role="textbox"][contenteditable="true"], div[data-slate-editor="true"], div[aria-label^="Message @"]';
  const composerCount = await s.page.locator(composerSel).filter({ visible: true }).count().catch(() => 0);
  if (!composerCount) {
    const friendGate = await s.page.locator(':text("Add Friend"), :text("send them a friend request"), :text("only allow")').count().catch(() => 0);
    console.log(friendGate > 0 ? 'FAIL: recipient requires friend status before DMs' : 'FAIL: composer not visible after recipient selected');
    process.exit(1);
  }
  const composer = s.page.locator(composerSel).filter({ visible: true }).first();
  await humanClickLocator(s.page, composer);
  await humanType(s.page, MESSAGE);
  await humanIdlePause('short');
  await s.page.keyboard.press('Enter');
  await humanIdlePause('deliberate');

  const echoCount = await s.page.locator(`[role="article"]:has-text("${MESSAGE.slice(0, 60)}"), li[id^="chat-messages-"]:has-text("${MESSAGE.slice(0, 60)}")`).filter({ visible: true }).count().catch(() => 0);
  if (!echoCount) { console.log('FAIL: composer typed but message not echoed in chat'); process.exit(1); }
  console.log(`PASS: DM sent to @${RECIPIENT}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
