import { WSession } from '../../../dist/session/wsession.js';
import { findActiveAccount, injectCookies, loginViaTwitter } from './_session.mjs';

// Post a comment on a Product Hunt launch.
// PRODUCTHUNT_URL=https://www.producthunt.com/products/<slug>  -> launch page
// PH_COMMENT="text"                                            -> overrides default

const TARGET_URL = process.env.PRODUCTHUNT_URL || 'https://www.producthunt.com/';
const COMMENT_TEXT = process.env.PH_COMMENT || 'Looks really clean — congrats on the launch!';
const USE_BRIGHTDATA = !!process.env.BRIGHTDATA_BROWSER_WS;
const proxy = USE_BRIGHTDATA ? 'none' : (process.env.PROXY_URL || 'none');
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

async function postComment(s) {
  const acct = await findActiveAccount('producthunt');
  if (!acct) throw new Error('no_producthunt_account_in_db');
  const cookies = acct.metadata?.cookies ?? [];
  console.log(`[ph-comment] using account: ${acct.username} (${cookies.length} cookies)`);
  if (cookies.length < 1) throw new Error('producthunt_account_missing_cookies');

  const inj = await injectCookies(s, cookies, '.producthunt.com');
  console.log(`[ph-comment] injected ${inj} producthunt cookies`);

  await s.goto(TARGET_URL);
  await sleep(4);

  let cur = s.page.url();
  console.log(`[ph-comment] initial nav: ${cur}`);
  if (cur.includes('/login') || cur.includes('/captcha_verification')) {
    await loginViaTwitter(s);
    await s.goto(TARGET_URL);
    await sleep(4);
    cur = s.page.url();
    if (cur.includes('/login') || cur.includes('/captcha_verification')) throw new Error('still_blocked_after_relogin');
  }

  // Find the comment input (textarea or contenteditable)
  const taInfo = await s.page.evaluate(`(() => {
    var tas = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]'));
    for (var ta of tas) {
      var ph = (ta.getAttribute('placeholder') || ta.getAttribute('aria-label') || '').toLowerCase();
      var rect = ta.getBoundingClientRect();
      if (rect.width < 100 || rect.height < 20) continue;
      if (ph.includes('comment') || ph.includes('think') || ph.includes('thoughts') || ph.includes('say something') || ph.includes('write')) {
        ta.scrollIntoView({ block: 'center' });
        return { tag: ta.tagName, ph: ph, rect: { x: rect.x + rect.width/2, y: rect.y + rect.height/2 } };
      }
    }
    return null;
  })()`).catch(() => null);
  if (!taInfo) throw new Error('comment_input_not_found');
  console.log(`[ph-comment] found input: ${taInfo.tag} placeholder="${taInfo.ph}"`);

  await s.page.mouse.click(taInfo.rect.x, taInfo.rect.y).catch(() => {});
  await sleep(1);
  await s.page.keyboard.type(COMMENT_TEXT, { delay: 30 }).catch(() => {});
  await sleep(2);

  const submitResult = await s.page.evaluate(`(() => {
    var btns = Array.from(document.querySelectorAll('button[type="submit"], button'));
    for (var b of btns) {
      var t = (b.textContent || '').trim().toLowerCase();
      if (t === 'comment' || t === 'post' || t === 'send' || t === 'submit') {
        b.disabled = false;
        b.scrollIntoView({ block: 'center' });
        b.click();
        return 'clicked: ' + t;
      }
    }
    return 'no-submit-button';
  })()`).catch(() => null);
  console.log(`[ph-comment] submit: ${submitResult}`);
  await sleep(5);

  const found = await s.page.evaluate(`(() => {
    var txt = ${JSON.stringify(COMMENT_TEXT.slice(0, 60))};
    return (document.body?.innerText || '').includes(txt);
  })()`).catch(() => false);
  if (!found) throw new Error(`comment_not_found_after_post: url=${s.page.url().slice(-60)}`);

  console.log(`[ph-comment] comment registered`);
  return acct.username;
}

const s = await WSession.start({ label: 'producthunt_comment', proxy });
try {
  const username = await postComment(s);
  console.log(`PASS: ${username} commented on ${TARGET_URL}`);
  await s.close();
  process.exit(0);
} catch (e) {
  console.log(`FAIL: ${e.message?.slice(0, 200)}`);
  await s.close().catch(() => {});
  process.exit(1);
}
