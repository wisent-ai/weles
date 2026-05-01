import { getSocialAccount, markCookiesStale } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../_shared/cookie-freshness.mjs';

const VIDEO = process.env.VIDEO_URL || 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const COMMENT = process.env.COMMENT_TEXT || 'Great video!';

const acct = await getSocialAccount('youtube');
if (!acct) { console.log('FAIL: no active youtube account in DB'); process.exit(1); }
console.log(`[trajectory] Using account: ${acct.username} video=${VIDEO}`);

const s = await WSession.start({ label: 'youtube_comment', proxy: process.env.PROXY_URL || undefined });
try {
  // Cookie injection — youtube_login persists Google + youtube cookies; this
  // trajectory assumes a previously-authenticated account. If logged out we
  // throw, since the YT comment form refuses anonymous submissions.
  // Cookie freshness gate — see _shared/cookie-freshness.mjs.
  let stored;
  try {
    stored = loadFreshCookieJarOrFail(acct, { platform: 'youtube', label: 'youtube_comment', currentProxyUrl: proxyUrl, currentPersona: persona });
  } catch (jarErr) {
    if (jarErr instanceof CookieJarStaleError) { console.log(`FAIL: ${jarErr.message}`); await markCookiesStale(acct.id); await s.close().catch(() => {}); process.exit(1); }
    throw jarErr;
  }
  await s.ctx.addCookies(stored.filter(c => c?.name && c?.value && (c.domain || c.url)).map(c => ({ ...c, path: c.path || '/' }))).catch(() => {});

  await s.goto(VIDEO);
  await s.page.waitForTimeout(4500);
  const loggedOut = await s.page.evaluate(() => !!document.querySelector('a[href^="https://accounts.google.com/ServiceLogin"]') && !document.querySelector('img#avatar-btn'));
  if (loggedOut) { await markCookiesStale(acct.id); throw new Error('not_logged_in: cookies stale — run youtube_login first'); }
  // Positive auth probe — see _shared/auth-probe.mjs.
  try { await assertAuthed('youtube', s, { label: 'youtube_comment' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // Scroll to comment section: #comments anchor.
  await s.page.evaluate(() => { document.querySelector('#comments')?.scrollIntoView({ block: 'center' }); }).catch(() => {});
  await s.page.waitForTimeout(2500);
  // Placeholder "Add a comment..." — clicking it expands the input box.
  const placeholder = s.page.locator('#placeholder-area, ytd-comment-simplebox-renderer #simplebox-placeholder').filter({ visible: true }).first();
  await placeholder.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, placeholder);
  await s.page.waitForTimeout(1200);
  // Expanded input: contenteditable div.
  const input = s.page.locator('div#contenteditable-root[contenteditable="true"], ytd-commentbox div[contenteditable="true"]').filter({ visible: true }).first();
  await input.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, input);
  await humanType(s.page, COMMENT);
  await s.page.waitForTimeout(800);
  // Submit button — id=submit-button or aria-label="Comment".
  const submit = s.page.locator('ytd-commentbox #submit-button button, ytd-button-renderer#submit-button button, button[aria-label="Comment"]').filter({ visible: true }).first();
  await submit.waitFor({ state: 'visible' });
  await humanClickLocator(s.page, submit);
  await s.page.waitForTimeout(3500);
  console.log(`PASS: commented`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
