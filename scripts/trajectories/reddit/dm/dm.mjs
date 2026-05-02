import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../../dist/utils/credentials.js';
import { WSession } from '../../../../dist/session/wsession.js';
import { humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../../_shared/cookie-freshness.mjs';

// Reddit messaging surfaces:
//   * legacy PM at old.reddit.com/message/compose — subject + body, persistent,
//     non-realtime, works from cookie replay with no Matrix handshake.
//   * chat.reddit.com (Matrix-backed realtime DM) — extra device attestation
//     and a separate cookie minted by the chat OAuth flow.
// We use the legacy PM surface — only deterministic path the routine layer
// already permits.
const RECIPIENT = (process.env.RECIPIENT_HANDLE || 'reddit').replace(/^u\//, '').replace(/^\//, '');
const SUBJECT = process.env.DM_SUBJECT || 'hi';
const MESSAGE = process.env.DM_MESSAGE || 'Hello from weles agent';

const acct = await getSocialAccount('reddit');
if (!acct) { console.log('FAIL: no active reddit account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username}`);

const { proxyUrl, persona } = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'reddit_dm', proxy: proxyUrl, persona });

try {
  let stored;
  try {
    const all = loadFreshCookieJarOrFail(acct, { platform: 'reddit', label: 'reddit_dm', currentProxyUrl: proxyUrl, currentPersona: persona });
    stored = all.filter(c => /reddit\.com/.test(c.domain ?? ''));
    if (!stored.length) throw new CookieJarStaleError('cookie_jar_no_domain_match: jar fresh but no reddit.com cookies', { platform: 'reddit' });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.map(c => ({ ...c, path: c.path || '/' })));

  // Auth-probe on a real shell — the compose page renders the form even
  // when logged out, so it's an unreliable place to probe.
  await s.goto('https://old.reddit.com/');
  await s.page.waitForTimeout(2500);
  try { await assertAuthed('reddit', s, { label: 'reddit_dm' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  await s.goto(`https://old.reddit.com/message/compose/?to=${encodeURIComponent(RECIPIENT)}`);
  await s.page.waitForTimeout(2500);

  const toIn = s.page.locator('input#send_to, input[name="to"]').filter({ visible: true }).first();
  await toIn.waitFor({ state: 'visible' });
  const currentTo = await toIn.inputValue().catch(() => '');
  if (!currentTo || currentTo.toLowerCase() !== RECIPIENT.toLowerCase()) {
    await humanClickLocator(s.page, toIn);
    await s.page.keyboard.press('Meta+A').catch(() => {});
    await s.page.keyboard.press('Control+A').catch(() => {});
    await s.page.keyboard.press('Backspace').catch(() => {});
    await humanType(s.page, RECIPIENT);
  }

  const subjectIn = s.page.locator('input#subject, input[name="subject"]').filter({ visible: true }).first();
  await humanClickLocator(s.page, subjectIn);
  await humanType(s.page, SUBJECT);

  const bodyIn = s.page.locator('textarea#message-text, textarea[name="text"]').filter({ visible: true }).first();
  await humanClickLocator(s.page, bodyIn);
  await humanType(s.page, MESSAGE);

  const sendBtn = s.page.locator('form#compose-message button[type="submit"], button.btn:has-text("send"), button[name="send"]').filter({ visible: true }).first();
  await sendBtn.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, sendBtn);

  await s.page.waitForTimeout(4000);
  const successCount = await s.page.locator(':text("your message has been delivered"), :text("message delivered"), .status:has-text("delivered")').count().catch(() => 0);
  const errorHits = await s.page.evaluate(() => {
    const txt = (document.body?.innerText || '').toLowerCase();
    const hits = [];
    if (/doesn't exist|user doesn't exist|that user does not exist/.test(txt)) hits.push('user_not_found');
    if (/doing that too much|ratelimit|rate limit|try again in/.test(txt)) hits.push('ratelimit');
    if (/captcha/.test(txt)) hits.push('captcha');
    if (/blocked|cannot send|don't accept/.test(txt)) hits.push('blocked');
    return hits;
  }).catch(() => []);
  if (errorHits.length) { console.log(`FAIL: ${errorHits.join(',')}`); process.exit(1); }
  if (!successCount) { console.log('FAIL: no delivery confirmation on response page'); process.exit(1); }
  console.log(`PASS: DM (PM) sent to u/${RECIPIENT}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
