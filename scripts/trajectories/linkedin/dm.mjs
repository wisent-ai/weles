import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../_shared/cookie-freshness.mjs';

// RECIPIENT_HANDLE accepts vanity ("williamhgates") or full /in/ URL. We
// always click "Message" on the public profile — the only deterministic
// LinkedIn DM path. The /messaging/ composer typeahead surfaces "Connect"
// cohort users mis-matched against the intended recipient on small accounts.
const RECIPIENT = (process.env.RECIPIENT_HANDLE || 'williamhgates').replace(/^@/, '').replace(/\/$/, '');
const MESSAGE = process.env.DM_MESSAGE || 'Hello from weles agent';
const profileUrl = /^https?:\/\//.test(RECIPIENT) ? RECIPIENT : `https://www.linkedin.com/in/${encodeURIComponent(RECIPIENT)}/`;

const acct = await getSocialAccount('linkedin');
if (!acct) { console.log('FAIL: no active linkedin account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'linkedin_dm', proxy: proxyUrl, persona });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'linkedin', label: 'linkedin_dm', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /linkedin\.com/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no linkedin.com cookies', { platform: 'linkedin' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  await s.page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(4500);
  if (/\/(login|checkpoint|uas)/.test(s.page.url())) {
    console.log(`FAIL: cookies stale, redirected to ${s.page.url()}`);
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  try { await assertAuthed('linkedin', s, { label: 'linkedin_dm' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  await s.page.goto(profileUrl, { waitUntil: 'domcontentloaded' });
  await s.page.waitForTimeout(4500);

  // No Message button = not connected + not Open Profile → DM impossible
  // without InMail credits. Surface as structured FAIL early.
  const msgSel = 'button:has-text("Message"), a:has-text("Message"), button[aria-label*="Message" i]';
  const msgCount = await s.page.locator(msgSel).filter({ visible: true }).count().catch(() => 0);
  if (!msgCount) {
    console.log('FAIL: recipient profile has no Message button (not connected; InMail required)');
    process.exit(1);
  }
  await humanClickLocator(s.page, s.page.locator(msgSel).filter({ visible: true }).first());
  await s.page.waitForTimeout(2500);

  const composer = s.page.locator('div.msg-form__contenteditable[contenteditable="true"], div[role="textbox"][contenteditable="true"]').filter({ visible: true }).first();
  await composer.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, composer);
  await humanType(s.page, MESSAGE);
  await s.page.waitForTimeout(800);

  const sendBtn = s.page.locator('button.msg-form__send-button, button[aria-label*="Send" i]:not([disabled])').filter({ visible: true }).first();
  await sendBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, sendBtn);
  await s.page.waitForTimeout(3500);

  const echoCount = await s.page.locator(`.msg-s-event-listitem :text("${MESSAGE.slice(0, 60)}"), li.msg-s-message-list__event :text("${MESSAGE.slice(0, 60)}"), :text("${MESSAGE.slice(0, 60)}")`).filter({ visible: true }).count().catch(() => 0);
  if (!echoCount) { console.log('FAIL: composer typed but message not echoed in conversation'); process.exit(1); }
  console.log(`PASS: DM sent to ${RECIPIENT}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
