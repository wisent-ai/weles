import { getSocialAccount, markCookiesStale } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator } from '../../dist/human/mouse.js';
import { assertAuthed, AuthProbeError } from './_shared/auth-probe.mjs';

const TARGET = process.env.GITHUB_STAR_TARGET ?? 'https://github.com/anthropics/claude-code';

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
console.log(`[star] Account: ${acct.username} → Target: ${TARGET}`);

let s;
for (let retry = 0; retry < 3; retry++) {
  try {
    s = await WSession.start({ label: 'github_star', proxy: proxyUrl });
    const cookies = (acct.metadata.cookies ?? []).filter(c => (c.domain ?? '').includes('github.com'));
    if (cookies.length) await s.ctx.addCookies(cookies).catch(() => {});
    await s.goto(TARGET);
    let rendered = false;
    for (let i = 0; i < 15; i++) {
      if (await s.page.evaluate('document.readyState === "complete" && document.body?.innerText?.length > 100').catch(() => false)) { rendered = true; break; }
      await s.wait(1);
    }
    if (rendered) break;
  } catch (e) { console.log(`[star] Attempt ${retry + 1} crashed: ${e.message?.slice(0, 100)}`); }
  await s?.close().catch(() => {});
  s = null;
}
if (!s) { console.log('FAIL: page never rendered'); process.exit(1); }

try {
  const cookies = await s.ctx.cookies();
  const hasSession = cookies.some(c => c.name === 'user_session' && c.value);
  if (!hasSession) {
    console.log('FAIL: not logged in (no user_session cookie). Run github_login.mjs first.');
    await markCookiesStale(acct.id);
    process.exit(1);
  }
  // Positive auth probe — see _shared/auth-probe.mjs.
  try { await assertAuthed('github', s, { label: 'github_star' }); }
  catch (probeErr) { if (probeErr instanceof AuthProbeError) { console.log(`FAIL: ${probeErr.message}`); await markCookiesStale(acct.id); process.exit(1); } throw probeErr; }

  // Detect state via which form is visible. GitHub renders both /star and /unstar forms; one is hidden via parent container.
  const state = await s.page.evaluate(`(() => {
    const isVisible = el => !!el && el.offsetParent !== null;
    const starForm = document.querySelector('form[action$="/star"]');
    const unstarForm = document.querySelector('form[action$="/unstar"]');
    return {
      starVisible: isVisible(starForm),
      unstarVisible: isVisible(unstarForm),
      starExists: !!starForm,
      unstarExists: !!unstarForm,
    };
  })()`).catch(() => ({}));
  console.log(`[star] State: ${JSON.stringify(state)}`);
  if (state.unstarVisible) { console.log(`PASS: already starred ${TARGET}`); process.exit(0); }

  // Click the visible Star button — locator.click auto-waits for visible
  // and routes through CDP with isTrusted=true (github's spam ML reads that).
  const starLoc = s.page.locator('form[action$="/star"]:visible button[type="submit"]').first();
  let clicked;
  if (await starLoc.count()) {
    await humanClickLocator(s.page, starLoc).catch(() => {});
    clicked = { clicked: true, via: 'form-button' };
  } else {
    const formSubmit = await s.page.evaluate(`(() => { const f = document.querySelector('form[action$="/star"]'); if (f) { f.requestSubmit?.(); return true; } return false; })()`).catch(() => false);
    clicked = formSubmit ? { clicked: true, via: 'form-submit' } : { clicked: false };
  }
  console.log(`[star] Click: ${JSON.stringify(clicked)}`);
  await s.wait(3);

  let starred = await s.page.evaluate(`(() => {
    const unstar = document.querySelector('form[action$="/unstar"]');
    return !!unstar && unstar.offsetParent !== null;
  })()`).catch(() => false);

  if (!starred) {
    console.log('[star] UI click did not register, trying direct form POST with auth token');
    const parts = TARGET.replace(/\/$/, '').split('/');
    const repo = parts.slice(-2).join('/');
    const apiRes = await s.page.evaluate(`(async () => {
      const form = document.querySelector('form[action$="/star"]');
      if (!form) return { error: 'no_star_form' };
      const token = form.querySelector('input[name="authenticity_token"]')?.value;
      if (!token) return { error: 'no_token' };
      const body = new URLSearchParams();
      body.set('authenticity_token', token);
      body.set('context', 'repository');
      const r = await fetch('/${repo}/star', {
        method: 'POST', headers: { 'Accept': 'text/html', 'X-Requested-With': 'XMLHttpRequest' }, body,
      });
      return { status: r.status, ok: r.ok };
    })()`).catch(e => ({ error: e.message }));
    console.log(`[star] API: ${JSON.stringify(apiRes)}`);
    if (apiRes?.ok) starred = true;
  }

  if (starred) console.log(`PASS: starred ${TARGET}`);
  else { console.log(`FAIL: star did not register`); process.exit(1); }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
