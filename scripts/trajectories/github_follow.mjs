import { getSocialAccount } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator } from '../../dist/human/mouse.js';

const TARGET = process.env.GITHUB_FOLLOW_TARGET ?? 'lbartoszcze';

const acct = await getSocialAccount('github');
if (!acct) { console.log('FAIL: no active github account in DB'); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password ?? '';

const savedProxy = acct.metadata.proxy;
let proxyUrl = process.env.PROXY_URL || 'residential';
if (savedProxy?.server && savedProxy?.username) {
  const u = new globalThis.URL(savedProxy.server);
  proxyUrl = `${u.protocol}//${savedProxy.username}:${savedProxy.password}@${u.hostname}:${u.port}`;
}
console.log(`[follow] Account: ${acct.username} → Target: ${TARGET}`);

let s;
for (let retry = 0; retry < 3; retry++) {
  try {
    s = await WSession.start({ label: 'github_follow', proxy: proxyUrl });
    const cookies = (acct.metadata.cookies ?? []).filter(c => (c.domain ?? '').includes('github.com'));
    if (cookies.length) await s.ctx.addCookies(cookies).catch(() => {});
    await s.goto(`https://github.com/${TARGET}`);
    let rendered = false;
    for (let i = 0; i < 15; i++) {
      if (await s.page.evaluate('document.readyState === "complete" && document.body?.innerText?.length > 100').catch(() => false)) { rendered = true; break; }
      await s.wait(1);
    }
    if (rendered) break;
  } catch (e) { console.log(`[follow] Attempt ${retry + 1} crashed: ${e.message?.slice(0, 100)}`); }
  await s?.close().catch(() => {});
  s = null;
}
if (!s) { console.log('FAIL: page never rendered'); process.exit(1); }

try {
  // Verify logged in (cookie session)
  const cookies = await s.ctx.cookies();
  const hasSession = cookies.some(c => c.name === 'user_session' && c.value);
  if (!hasSession) {
    console.log('FAIL: not logged in (no user_session cookie). Run github_login.mjs first.');
    process.exit(1);
  }

  // Check current state: visible Unfollow = already following; visible Follow = not yet
  const state = await s.page.evaluate(`(() => {
    const follow = document.querySelector('input[type="submit"][value="Follow"]');
    const unfollow = document.querySelector('input[type="submit"][value="Unfollow"]');
    const isVisible = el => !!el && el.offsetParent !== null && !el.closest('[hidden]');
    return {
      followVisible: isVisible(follow),
      unfollowVisible: isVisible(unfollow),
      followExists: !!follow,
      unfollowExists: !!unfollow,
    };
  })()`).catch(() => ({}));
  console.log(`[follow] State: ${JSON.stringify(state)}`);
  if (state.unfollowVisible) { console.log(`PASS: already following ${TARGET}`); process.exit(0); }

  // Click Follow — locator.click auto-waits for visible + enabled, which
  // filters out any hidden duplicate Follow forms github ships.
  const followLoc = s.page.locator('input[type="submit"][value="Follow"]:visible').first();
  let clicked;
  if (await followLoc.count()) {
    await humanClickLocator(s.page, followLoc).catch(() => {});
    clicked = { clicked: true, tag: 'input-visible' };
  } else {
    const formSubmit = await s.page.evaluate(`(() => { const f = document.querySelector('form[action*="/users/follow"]'); if (f) { f.removeAttribute('hidden'); f.requestSubmit?.(); return true; } return false; })()`).catch(() => false);
    clicked = formSubmit ? { clicked: true, tag: 'form-submit' } : { clicked: false };
  }
  console.log(`[follow] Click: ${JSON.stringify(clicked)}`);
  await s.wait(3);

  const followed = await s.page.evaluate(`(() => {
    const unfollow = document.querySelector('input[type="submit"][value="Unfollow"]');
    return !!unfollow && unfollow.offsetParent !== null;
  })()`).catch(() => false);

  if (followed) { console.log(`PASS: followed ${TARGET}`); }
  else {
    const err = await s.page.evaluate("(()=>{const e=document.querySelector('.flash-error,[role=\"alert\"]'); return e?e.innerText.trim().slice(0,200):null;})()").catch(() => null);
    console.log(`FAIL: follow did not register${err ? ` — ${err}` : ''}`);
    process.exit(1);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
