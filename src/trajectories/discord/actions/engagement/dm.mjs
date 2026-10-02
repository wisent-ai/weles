import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../../dist/utils/credentials.js';
import { WSession } from '../../../../../dist/session/wsession.js';
import { humanFill } from '../../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../../../_shared/auth/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../../_shared/auth/cookie-freshness.mjs';
import { pageCondition, responseAfterAction, urlMatching } from '../../../_shared/page/settled.mjs';
import { checkReachable } from '../../../_shared/action-runner.mjs';
import { readDiscordReply } from '../../../_shared/discord/response.mjs';

// Distinct from discord/organic_message.mjs (which posts into a guild channel
// at SERVER_CHANNEL_PATH). This one is a real 1:1 DM via the Cmd/Ctrl+K
// quick-switcher → search by username → recipient row → composer.
const RECIPIENT = (process.env.RECIPIENT_HANDLE || '').replace(/^@/, '');
const MESSAGE = process.env.DM_MESSAGE || 'Hello from weles agent';
if (!RECIPIENT.trim()) { console.error('DISCORD_DM_RECIPIENT_REQUIRED: RECIPIENT_HANDLE must name a Discord username'); process.exit(1); }

const acct = await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no active discord account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username} → @${RECIPIENT}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'discord_dm', proxy: proxyUrl, persona });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'discord', label: 'discord_dm', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /(^|\.)discord\.com$/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no discord.com cookies', { platform: 'discord' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) {
      try { await markCookiesStale(acct.id); }
      catch (cause) { console.error('DISCORD_DM_COOKIE_STATE_WRITE_FAILED:', cause); }
    }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.goto('https://discord.com/channels/@me');
  checkReachable(s, 'discord');
  await pageCondition(s.page, () => {
    if (/^\/login(?:\/|$)/.test(location.pathname)) return true;
    return [...document.querySelectorAll('button[aria-label="User Settings"]')]
      .some(button => button.getClientRects().length && getComputedStyle(button).visibility !== 'hidden');
  });
  if (/\/login/.test(s.page.url())) {
    const error = Object.assign(new Error('DISCORD_DM_LOGIN_REQUIRED: the saved session reached the login page'),
      { pageUrl: s.page.url(), accountId: acct.id });
    try { await markCookiesStale(acct.id); }
    catch (cause) { console.error('DISCORD_DM_COOKIE_STATE_WRITE_FAILED:', cause); }
    throw error;
  }
  try { await assertAuthed('discord', s, { label: 'discord_dm' }); }
  catch (probeErr) {
    if (probeErr instanceof AuthProbeError) {
      try { await markCookiesStale(acct.id); }
      catch (cause) { console.error('DISCORD_DM_COOKIE_STATE_WRITE_FAILED:', cause); }
    }
    throw probeErr;
  }

  // Choose one entry point before acting, rather than opening the switcher twice.
  const switcherSel = 'input[placeholder*="Where would you like to go" i], div[role="combobox"] input, input[role="combobox"]';
  const findPill = s.page.locator('button:has-text("Find or start a conversation"), [role="button"]:has-text("Find or start a conversation")').filter({ visible: true }).first();
  if (await findPill.count()) await humanClickLocator(s.page, findPill);
  else {
    const isMac = await s.page.evaluate(() => /Mac/i.test(navigator.platform));
    await s.page.keyboard.press(isMac ? 'Meta+K' : 'Control+K');
  }
  const queryIn = s.page.locator(switcherSel).filter({ visible: true }).first();
  await queryIn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, queryIn);
  await humanFill(s.page, queryIn, RECIPIENT);

  const handleText = s.page.getByText(RECIPIENT, { exact: true }).or(s.page.getByText(`@${RECIPIENT}`, { exact: true }));
  const userRow = s.page.locator('[role="listbox"] [role="option"]')
    .filter({ has: handleText, visible: true }).first();
  await userRow.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, userRow);
  const channelUrl = await urlMatching(s.page, /^https:\/\/discord\.com\/channels\/@me\/\d+(?:[?#].*)?$/);
  const channelId = new URL(channelUrl).pathname.split('/').pop();

  // A visible editor is readiness; old matching messages are not a send receipt.
  const composerSel = 'div[role="textbox"][contenteditable="true"], div[data-slate-editor="true"], div[aria-label^="Message @"]';
  const composer = s.page.locator(composerSel).filter({ visible: true }).first();
  await composer.waitFor({ state: 'visible' });
  if (!await composer.isEditable()) {
    throw Object.assign(new Error('DISCORD_DM_COMPOSER_NOT_EDITABLE'),
      { pageUrl: s.page.url(), recipientRequested: RECIPIENT });
  }
  await humanClickLocator(s.page, composer);
  await humanFill(s.page, composer, MESSAGE);
  const messagePath = new RegExp(`^/api/v\\d+/channels/${channelId}/messages$`);
  const response = await responseAfterAction(s.page, (request) => {
    const url = new URL(request.url());
    return request.method() === 'POST' && url.origin === 'https://discord.com' && messagePath.test(url.pathname);
  }, () => s.page.keyboard.press('Enter'));
  const message = await readDiscordReply(response, 'direct_message', 'DISCORD_DM');
  if (typeof message?.id !== 'string' || !/^\d+$/.test(message.id)
      || message.channel_id !== channelId || message.content !== MESSAGE || message.type !== 0) {
    throw Object.assign(new Error('DISCORD_DM_UNCONFIRMED: reconcile the provider response before another attempt'),
      { operation: 'direct_message', recipientRequested: RECIPIENT, responseBody: message,
        requestUrl: response.url(), httpStatus: response.status() });
  }
  console.log(JSON.stringify({
    ok: true, operation: 'direct_message', acknowledgement: 'provider_response',
    recipient_requested: RECIPIENT, channel_id: channelId, message_id: message.id,
    url: `https://discord.com/channels/@me/${channelId}/${message.id}`,
  }));
} catch (e) {
  console.error('DISCORD_DM_FAILED:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
