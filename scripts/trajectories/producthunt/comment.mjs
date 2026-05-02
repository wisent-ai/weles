import { WSession } from '../../../dist/session/wsession.js';
import { getSocialAccount, resolveAccountSession, markCookiesStale } from '../../../dist/utils/credentials.js';
import { injectPHCookies, loginViaTwitter } from './_session.mjs';
import { humanType, humanFill } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from '../_shared/auth-probe.mjs';
import { loadFreshCookieJarOrFail, CookieJarStaleError } from '../_shared/cookie-freshness.mjs';

// Post a comment on a Product Hunt launch.
// PRODUCTHUNT_URL=https://www.producthunt.com/products/<slug>  -> launch page
// PH_COMMENT="text"                                            -> overrides default

const TARGET_URL = process.env.PRODUCTHUNT_URL || 'https://www.producthunt.com/';
const COMMENT_TEXT = process.env.PH_COMMENT || 'Looks really clean — congrats on the launch!';
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

async function postComment(s, acct, sessionMeta) {
  // Cookie-jar freshness gate — see _shared/cookie-freshness.mjs. On stale,
  // skip injection and let loginViaTwitter recover below.
  let cookies = [];
  try {
    cookies = loadFreshCookieJarOrFail(acct, { platform: 'producthunt', label: 'producthunt_comment', currentProxyUrl: sessionMeta.proxyUrl, currentPersona: sessionMeta.persona });
  } catch (jarErr) {
    if (!(jarErr instanceof CookieJarStaleError)) throw jarErr;
    console.log(`[ph-comment] ${jarErr.message} — falling through to SSO recovery`);
    cookies = [];
  }
  if (cookies.length) {
    const inj = await injectPHCookies(s, cookies);
    console.log(`[ph-comment] injected ${inj} saved cookies`);
  }

  await s.goto(TARGET_URL);
  await sleep(4);

  let cur = s.page.url();
  console.log(`[ph-comment] initial nav: ${cur}`);
  // PH forum pages don't redirect logged-out visitors; they just hide the
  // reply input. Detect that explicitly via Sign-in button presence.
  const needsLogin = cur.includes('/login') || cur.includes('/captcha_verification') ||
    await s.page.evaluate(`(() => !!Array.from(document.querySelectorAll('button,a')).find(e => /^Sign in$/i.test((e.textContent||'').trim())))()`).catch(() => false);
  if (needsLogin) {
    console.log('[ph-comment] session not authenticated — running Twitter SSO');
    await loginViaTwitter(s);
    await s.goto(TARGET_URL);
    await sleep(4);
    cur = s.page.url();
    if (cur.includes('/login') || cur.includes('/captcha_verification')) throw new Error('still_blocked_after_relogin');
  }

  // Positive auth probe — see _shared/auth-probe.mjs.
  try { await assertAuthed('producthunt', s, { label: 'producthunt_comment' }); }
  catch (probeErr) {
    if (probeErr instanceof AuthProbeError) { try { await markCookiesStale(acct.id); } catch {} throw new Error(`auth_probe_failed: ${probeErr.message}`); }
    throw probeErr;
  }

  // PH forum comment editor is a TipTap/ProseMirror contenteditable. Target
  // it, type via keyboard (so Playwright routes real key events), then submit
  // via Cmd/Ctrl+Enter which TipTap wires up to the reply mutation.
  const editor = s.page.locator('[contenteditable="true"][role="textbox"].tiptap').first();
  await editor.waitFor();
  await humanClickLocator(s.page, editor);
  await humanType(s.page, COMMENT_TEXT);
  await sleep(1);
  await s.page.keyboard.press('Meta+Enter').catch(() => {});
  await s.page.keyboard.press('Control+Enter').catch(() => {});
  await sleep(4);

  const found = await s.page.evaluate(`(() => (document.body?.innerText || '').includes(${JSON.stringify(COMMENT_TEXT.slice(0, 60))}))()`).catch(() => false);
  if (found) return true;

  // Otherwise click a submit button by label via Playwright locator.
  const submitBtn = s.page.locator('button').filter({ hasText: /^(reply|send|submit)$/i }).first();
  let btnClicked = null;
  if ((await submitBtn.count()) && !(await submitBtn.isDisabled().catch(() => true))) {
    btnClicked = ((await submitBtn.innerText().catch(() => '')) ?? '').trim();
    await humanClickLocator(s.page, submitBtn).catch(() => {});
  }
  console.log(`[ph-comment] explicit submit button: ${btnClicked}`);
  await sleep(4);

  const found2 = await s.page.evaluate(`(() => (document.body?.innerText || '').includes(${JSON.stringify(COMMENT_TEXT.slice(0, 60))}))()`).catch(() => false);
  if (!found2) throw new Error(`comment_not_found_after_post: url=${s.page.url().slice(-60)}`);
  return true;
}

const acct = await getSocialAccount('producthunt');
if (!acct) { console.log('FAIL: no_producthunt_account_in_db'); process.exit(1); }
console.log(`[ph-comment] using account: ${acct.username}`);

const sessionOpts = await resolveAccountSession(acct);
const s = await WSession.start({ label: 'producthunt_comment', ...sessionOpts });
try {
  await postComment(s, acct, sessionOpts);
  console.log(`PASS: ${acct.username} commented on ${TARGET_URL}`);
  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  process.exit(1);
} finally {
  await s.close().catch(() => {});
}
