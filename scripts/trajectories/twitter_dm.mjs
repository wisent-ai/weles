import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanType } from '../../dist/human/keyboard.js';
import { humanClickLocator } from '../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from './_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from './_shared/cookie-freshness.mjs';

const RECIPIENT = process.env.RECIPIENT_HANDLE || 'wisent_ai';
const MESSAGE = process.env.DM_MESSAGE || 'Hello from weles agent';

const acct = await getSocialAccount('twitter');
if (!acct) { console.log('FAIL: no active twitter account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'twitter_dm', proxy: proxyUrl, persona });

try {
  // Cookie freshness gate — see _shared/cookie-freshness.mjs.
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'twitter', label: 'twitter_dm', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no x.com/twitter.com cookies', { platform: 'twitter' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(3000);
  if (/\/(i\/flow\/login|login)/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to login (${s.page.url()})`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  // Positive auth probe — see _shared/auth-probe.mjs.
  try { await assertAuthed('twitter', s, { label: 'twitter_dm' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // Compose URL pre-opens the new-message panel; we still need to pick the
  // recipient (no recipient_id pre-fill is supported without their numeric id).
  await s.page.goto('https://x.com/messages/compose', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(3000);

  // Recipient search input — Twitter uses input[data-testid="searchPeople"]
  // inside the new-conversation modal/panel.
  const searchIn = s.page.locator('input[data-testid="searchPeople"], input[aria-label*="Search people" i], div[role="dialog"] input[role="combobox"]').filter({ visible: true }).first();
  await searchIn.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, searchIn);
  await humanType(s.page, RECIPIENT);
  await s.page.waitForTimeout(2500);
  // Pick the first matching user cell — data-testid="TypeaheadUser" or
  // role="button" containing the @ handle. Filter to exact-match handle.
  const userRow = s.page.locator(`div[data-testid="TypeaheadUser"]:has-text("@${RECIPIENT}"), [role="button"]:has-text("@${RECIPIENT}")`).filter({ visible: true }).first();
  if (!(await userRow.count())) throw new Error(`recipient @${RECIPIENT} not found in search results`);
  await humanClickLocator(s.page, userRow);
  await s.page.waitForTimeout(1500);
  // "Next" button to confirm recipient selection.
  const nextBtn = s.page.locator('button[data-testid="nextButton"], div[role="button"]:has-text("Next")').filter({ visible: true }).first();
  if (await nextBtn.isVisible({ timeout: 2500 }).catch(() => false)) {
    await humanClickLocator(s.page, nextBtn);
    await s.page.waitForTimeout(2000);
  }

  // Message body — contenteditable div with data-testid="dmComposerTextInput".
  const msgIn = s.page.locator('div[data-testid="dmComposerTextInput"], div[contenteditable="true"][data-testid*="ComposerTextInput"], div[role="textbox"][data-testid*="dm" i]').filter({ visible: true }).first();
  await msgIn.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, msgIn);
  await humanType(s.page, MESSAGE);
  await s.page.waitForTimeout(800);
  // Send.
  const sendBtn = s.page.locator('button[data-testid="dmComposerSendButton"], div[data-testid="dmComposerSendButton"], button[aria-label*="Send" i]').filter({ visible: true }).first();
  await sendBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, sendBtn);
  await s.page.waitForTimeout(3000);
  console.log(`PASS: DM sent to @${RECIPIENT}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
