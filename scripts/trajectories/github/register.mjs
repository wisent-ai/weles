import { WSession } from '../../../dist/session/wsession.js';
import { solveFunCaptcha } from './_funcaptcha.mjs';
import { solveAudioPuzzle } from './_audio_solver.mjs';
import { solveRotationViaCoords } from './_coords_solver.mjs';
import { humanClick, humanClickLocator, nextInterClickMs } from '../../../dist/human/mouse.js'; import { humanType } from '../../../dist/human/keyboard.js';
import { autoBindCharacter } from '../lib/character-bind.mjs';

const URL = 'https://github.com/signup';

let s;
for (let retry = 0; retry < 3; retry++) {
  try {
    // No OS pin — persona OS rolls naturally. en-US locale pins language +
    // accept-language headers to match US proxy geolocation.
    s = await WSession.start({ label: 'github_register', proxy: process.env.PROXY_URL || 'residential', locale: 'en-US' });
    await s.goto('https://github.com/');
    let rendered = false;
    for (let i = 0; i < 15; i++) {
      if (await s.page.evaluate('document.readyState === "complete" && document.body && document.body.innerText.length > 100').catch(() => false)) { rendered = true; break; }
      await s.wait(1);
    }
    if (rendered) { console.log(`[register] Homepage rendered on attempt ${retry + 1}`); break; }
    console.log(`[register] Homepage failed on attempt ${retry + 1}, retrying...`);
  } catch (e) { console.log(`[register] Attempt ${retry + 1} crashed: ${e.message?.slice(0, 100)}`); }
  await s?.close().catch(() => {});
  s = null;
}
if (!s) { console.log('FAIL: homepage never rendered'); process.exit(1); }

try {
  const id = await s.generateIdentity('github');
  console.log(`[register] Identity: username=${id.username} email=${id.email}`);

  // Human warm-up before signup (DataDome trust)
  for (let i = 0; i < 5; i++) { await s.page.mouse.move(100 + Math.random() * 700, 100 + Math.random() * 500).catch(() => {}); await s.wait(0.5); }
  await s.page.evaluate('window.scrollBy(0, 300)').catch(() => {});
  await s.wait(2);

  // Intercept Arkose/FunCaptcha public_key + blob (context-level catches iframe requests)
  const captcha = { blob: null, pkey: null, apiSub: null };
  const seenArkoseUrls = [];
  const seenGithubPosts = [];
  s.ctx.on('request', (req) => {
    try {
      const u = req.url();
      if (req.method() === 'POST' && u.includes('github.com') && !u.includes('analytics') && !u.includes('_metric')) {
        seenGithubPosts.push(`${u.slice(0, 120)} body=${(req.postData() ?? '').slice(0, 150)}`);
      }
      if (u.includes('arkoselabs.com') || u.includes('octocaptcha.com')) {
        seenArkoseUrls.push(u.slice(0, 150));
        if (u.includes('arkoselabs.com/fc/gt2/public_key')) {
          const m = u.match(/public_key\/([A-F0-9-]+)/i);
          if (m) captcha.pkey = m[1];
          captcha.apiSub = new globalThis.URL(u).hostname;
          const body = req.postData() ?? '';
          const b = body.match(/data%5Bblob%5D=([^&]+)/) ?? body.match(/data\[blob\]=([^&]+)/);
          if (b) captcha.blob = decodeURIComponent(b[1]);
        }
        if ((u.includes('arkoselabs.com/fc/gc') || u.includes('arkoselabs.com/fc/gfct')) && !captcha.pkey) {
          const m = u.match(/[?&]public_key=([A-F0-9-]+)/i);
          if (m) captcha.pkey = m[1];
          if (!captcha.apiSub) captcha.apiSub = new globalThis.URL(u).hostname;
        }
      }
    } catch {}
  });

  await s.goto(URL);
  await s.wait(5);
  console.log(`[register] Signup page: ${s.page.url?.()}`);

  const fillField = async (selector, value) => {
    const v = s.resolveEnv(value);
    try { const bb = await s.page.locator(selector).first().boundingBox(); if (!bb) return { ok: false, reason: 'no-bbox' };
      await humanClick(s.page, Math.round(bb.x + bb.width / 2), Math.round(bb.y + bb.height / 2));
    } catch (e) { return { ok: false, reason: `click: ${e.message?.slice(0, 60)}` }; }
    await humanType(s.page, v); await s.page.keyboard.press('Tab').catch(() => {}); return { ok: true };
  };
  const pause = () => new Promise(r => setTimeout(r, nextInterClickMs()));  // allow-raw-playwright: utility sleep shim — usages should migrate to humanIdlePause
  const checkAlive = (tag, r) => { if (!r.ok && /closed|disconnect|Target/i.test(r.reason ?? '')) { console.log(`FAIL: browser died at ${tag} — ${r.reason}`); s.close().catch(()=>{}); process.exit(42); } };
  const er = await fillField('#email', '$GITHUB_NEW_EMAIL'); console.log(`[register] Fill email: ${JSON.stringify(er)}`); checkAlive('email', er); await pause();
  const pr = await fillField('#password', '$GITHUB_NEW_PASSWORD'); console.log(`[register] Fill password: ${JSON.stringify(pr)}`); checkAlive('password', pr); await pause();
  const ur = await fillField('#login', '$GITHUB_NEW_USERNAME'); console.log(`[register] Fill username: ${JSON.stringify(ur)}`); checkAlive('username', ur); await pause();

  // Country: check if auto-selected (usually from proxy IP). Only click dropdown if needed.
  const countryState = await s.page.evaluate(`(() => { const btn = document.querySelector('#country-dropdown-panel-button, button.country-select-button'); return { text: btn?.innerText?.trim().slice(0, 60) ?? '', found: !!btn }; })()`).catch(() => ({ found: false }));
  console.log(`[register] Country button: ${JSON.stringify(countryState)}`);
  if (countryState.found && !/united states|^us$/i.test(countryState.text)) {
    try {
      await humanClickLocator(s.page, s.page.locator('#country-dropdown-panel-button, button.country-select-button').first());
      await s.wait(1);
      // Pick the "United States" option via a trusted locator click. Re-check
      // innerText to exclude 'Virgin' / 'Minor' variants (hasText is substring).
      const all = await s.page.locator('[role="option"], li, button, a').filter({ hasText: /united states/i }).all().catch(() => []);
      let optClicked = { clicked: false };
      for (const el of all) { const t = ((await el.innerText().catch(() => '')) ?? '').trim(); if (/^united states/i.test(t) && !/virgin/i.test(t) && !/minor/i.test(t)) { await humanClickLocator(s.page, el).catch(() => {}); optClicked = { clicked: true, text: t.slice(0, 40) }; break; } }
      console.log(`[register] Country option click: ${JSON.stringify(optClicked)}`);
    } catch (e) { console.log(`[register] Country click error: ${e.message?.slice(0, 80)}`); }
  } else {
    console.log('[register] Country auto-selected — skipping');
  }
  await s.wait(2);

  // Wait for all 3 fields to show is-autocheck-successful (email/password/username validators pass)
  for (let i = 0; i < 30; i++) {
    const state = await s.page.evaluate(`(() => ({
      email: document.querySelector('#email')?.classList?.contains('is-autocheck-successful') ?? false,
      password: document.querySelector('#password')?.classList?.contains('is-autocheck-successful') ?? false,
      login: document.querySelector('#login')?.classList?.contains('is-autocheck-successful') ?? false,
    }))()`).catch(() => ({}));
    if (state.email && state.password && state.login) { console.log(`[register] All autochecks successful: ${JSON.stringify(state)}`); break; }
    if (i % 5 === 0) console.log(`[register] Waiting autocheck... ${i}s ${JSON.stringify(state)}`);
    await s.wait(1);
  }

  // Click "Create account" via humanClick (Bezier path, isTrusted=true)
  const createBtnSelector = 'button.js-octocaptcha-load-captcha, button[type="submit"]:has-text("Create account")';
  let clicked = { via: null };
  try {
    const btn = s.page.locator(createBtnSelector).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.scrollIntoViewIfNeeded().catch(() => {}); await s.wait(0.5);
      const bb = await btn.boundingBox();
      if (bb) { await humanClick(s.page, Math.round(bb.x + bb.width / 2), Math.round(bb.y + bb.height / 2)); clicked.via = 'humanClick'; }
      else { await humanClickLocator(s.page, btn); clicked.via = 'humanClickLocator'; }
    } else {
      // Locator-based text match: 'button:has-text("Create account")' filtered
      // to exclude OAuth variants. Avoids the evaluate-based btn.click() that
      // produces isTrusted=false events (octocaptcha / arkose flag those).
      const altLocator = s.page.locator('button:has-text("Create account"):not(:has-text("Google")):not(:has-text("Apple"))').first();
      if (await altLocator.isVisible().catch(() => false)) {
        await altLocator.scrollIntoViewIfNeeded().catch(() => {});
        await humanClickLocator(s.page, altLocator).catch(() => {});
        clicked = { via: 'locator-text', text: 'Create account' };
      }
    }
  } catch (e) { console.log(`[register] Create click error: ${e.message?.slice(0, 100)}`); }
  console.log(`[register] Create account click: ${JSON.stringify(clicked)}`);
  await s.screenshot('after_create_account_click').catch(() => {});

  // Wait for captcha iframe to load on its own (from click)
  for (let i = 0; i < 20 && !(captcha.pkey && captcha.blob); i++) {
    if (i % 5 === 0) console.log(`[register] Waiting captcha... ${i}s (arkose urls: ${seenArkoseUrls.length}, pkey=${captcha.pkey ? 'Y' : 'N'}, blob=${captcha.blob ? 'Y' : 'N'})`);
    await s.wait(1);
  }

  // Force iframe load if no arkose traffic seen
  if (seenArkoseUrls.length === 0) {
    const forced = await s.page.evaluate(`(() => { const f = document.querySelector('iframe.js-octocaptcha-frame'); if (!f) return { ok: false, reason: 'no-frame' }; const ds = f.getAttribute('data-src'); if (f.getAttribute('src')?.length > 10) return { ok: true, reason: 'already-loaded' }; if (ds) { f.setAttribute('src', ds); return { ok: true, reason: 'forced' }; } return { ok: false, reason: 'no-data-src' }; })()`).catch(() => ({ ok: false, reason: 'eval-error' }));
    console.log(`[register] Force iframe: ${JSON.stringify(forced)}`);
  }
  await s.wait(3);
  // postMessage ack to octocaptcha iframe (require_ack=true) so inner Arkose widget loads
  const ackRes = await s.page.evaluate(`(() => { const f = document.querySelector('iframe.js-octocaptcha-frame'); if (!f?.contentWindow) return { ok: false, reason: 'no-content-window' }; for (const msg of [{ type: 'ack', acked: true }, 'ack', { event: 'ack' }, { type: 'octocaptcha:ack' }]) { try { f.contentWindow.postMessage(msg, 'https://octocaptcha.com'); } catch {} try { f.contentWindow.postMessage(msg, '*'); } catch {} } return { ok: true }; })()`).catch(() => ({ ok: false }));
  console.log(`[register] postMessage ack: ${JSON.stringify(ackRes)}`);

  for (let i = 0; i < 60 && !captcha.blob; i++) {
    if (i % 10 === 0) console.log(`[register] Waiting Arkose widget... ${i}s (urls: ${seenArkoseUrls.length})`);
    await s.wait(1);
  }
  console.log(`[register] Arkose URLs (${seenArkoseUrls.length}):`);
  for (const u of seenArkoseUrls.slice(0, 15)) console.log(`  - ${u}`);
  console.log(`[register] GitHub POSTs during flow (${seenGithubPosts.length}):`);
  for (const p of seenGithubPosts.slice(0, 15)) console.log(`  - ${p}`);
  if (seenArkoseUrls.length < 15) { console.log(`IP_FLAGGED: only ${seenArkoseUrls.length} Arkose URLs (<15) — proxy burnt, rotate and retry`); await s.close().catch(()=>{}); process.exit(42); }

  // DOM-based extraction of pkey from iframe (data-src becomes src after load)
  if (!captcha.pkey) {
    const iframeInfo = await s.page.evaluate(`(() => {
      const frames = Array.from(document.querySelectorAll('iframe'));
      return frames.map(f => ({ src: f.src?.slice(0, 200) ?? '', dataSrc: f.getAttribute('data-src')?.slice(0, 200) ?? '', cls: f.className?.slice(0, 80) ?? '' })).filter(f => f.src || f.dataSrc);
    })()`).catch(() => []);
    console.log(`[register] All iframes: ${JSON.stringify(iframeInfo).slice(0, 500)}`);
    for (const f of iframeInfo) {
      const url = f.src || f.dataSrc;
      const m = url.match(/public_key=([A-F0-9-]+)/i) || url.match(/public_key\/([A-F0-9-]+)/i);
      if (m) { captcha.pkey = m[1]; break; }
    }
  }
  // Known GitHub FunCaptcha sitekey as last resort (public, documented)
  if (!captcha.pkey) {
    captcha.pkey = '***REMOVED-CAPTCHA-PKEY***';
    console.log('[register] Using known GitHub FunCaptcha sitekey');
  }
  if (!captcha.apiSub) captcha.apiSub = 'github-api.arkoselabs.com';
  console.log(`[register] Captcha: pkey=${captcha.pkey?.slice(0, 20)} blob=${captcha.blob?.slice(0, 30) ?? 'none'} sub=${captcha.apiSub}`);

  const ua = await s.page.evaluate('navigator.userAgent').catch(() => '');
  // Browser keep-alive during long solve — pings page every 3s so Chromium doesn't kill the context
  let keepAliveAbort = false;
  const keepAlive = (async () => { while (!keepAliveAbort) { await new Promise(r => setTimeout(r, 3000)); try { await s.page.evaluate('Date.now()'); } catch {} } })();  // allow-raw-playwright: review — context-dependent timer

  let solved = false;
  const isBD = !!process.env.BRIGHTDATA_BROWSER_WS;
  // BD Browser API: invoke Captcha.waitForSolve CDP method (auto-solver must be explicitly triggered)
  if (isBD) {
    console.log('[register] BD: invoking Captcha.waitForSolve via CDP');
    try {
      const cdp = await s.ctx.newCDPSession(s.page);
      const res = await cdp.send('Captcha.waitForSolve', { detectTimeout: 240000 });
      console.log(`[register] BD CDP Captcha.waitForSolve: ${JSON.stringify(res)}`);
      const u = s.page.url?.() ?? '';
      if (res.status === 'solved' || /signup_emailsent|verif|launch-code|account_verif/.test(u)) { console.log(`[register] BD solved, url=${u}`); solved = true; }
    } catch (e) { console.log(`[register] BD CDP error: ${e.message?.slice(0, 120)}`); }
  }
  if (!solved && !isBD) {
    for (const fn of [solveAudioPuzzle, solveRotationViaCoords]) {
      if (solved) break;
      const ok = await fn(s.page).catch(() => false);
      if (ok) { await s.wait(5); const u = s.page.url?.() ?? ''; if (/signup_emailsent|verif|launch-code|account_verif/.test(u)) solved = true; }
    }
  }
  // External solvers (anticaptcha/2captcha) return UNSOLVABLE on Arkose basket puzzles — opt-in only.
  const token = (solved || process.env.WELES_EXTERNAL_FUNCAPTCHA !== '1') ? null : (await solveFunCaptcha({ websiteURL: URL, publicKey: captcha.pkey, apiSub: captcha.apiSub, blob: captcha.blob, userAgent: ua, proxy: s.proxyConfig })).token;
  keepAliveAbort = true; await keepAlive.catch(() => {});
  if (token) {
    const inject = await s.page.evaluate(`(tk => {
      const inputs = document.querySelectorAll('input[name="octocaptcha-token"], input.js-octocaptcha-token');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const inp of inputs) { setter.call(inp, tk); inp.dispatchEvent(new Event('input', {bubbles:true})); inp.dispatchEvent(new Event('change', {bubbles:true})); }
      const cont = document.querySelector('[data-octocaptcha-token]');
      if (cont) cont.dataset.octocaptchaToken = tk;
      window.dispatchEvent(new CustomEvent('octocaptcha:solved', { detail: { token: tk } }));
      // Always form.requestSubmit() — routes through the form-submit pipeline
      // without an isTrusted=false click event. requestSubmit is supported on
      // Chromium 76+ (we run 147). No backup needed; if requestSubmit isn't
      // available the trajectory should fail loudly.
      const form = document.querySelector('form.js-octocaptcha-parent, form[data-octo-click-hmac]');
      if (form && typeof form.requestSubmit === 'function') { form.requestSubmit(); return { injected: inputs.length, clicked: 'form-requestSubmit' }; }
      return { injected: inputs.length, clicked: false, reason: 'no form.requestSubmit available' };
    })(${JSON.stringify(token)})`).catch(e => ({ error: e.message?.slice(0, 150) }));
    console.log(`[register] Token injection: ${JSON.stringify(inject)} region=${token.match(/r=([^|&]+)/)?.[1] ?? '?'}`);
    // Wait up to 20s for URL to advance — GitHub validates the token server-side
    // and the redirect can take several seconds even on a good token.
    for (let w = 0; w < 20 && !solved; w++) {
      await s.wait(1);
      const u = s.page.url?.() ?? '';
      if (/signup_emailsent|verif|launch-code|account_verif/.test(u)) { console.log(`[register] Captcha accepted at ${u} (after ${w}s)`); solved = true; }
    }
    if (!solved) {
      const err = await s.page.evaluate("(() => { const e=document.querySelector('.flash-error,[role=\"alert\"]'); return e?e.innerText.trim().slice(0,200):null; })()").catch(() => null);
      if (err) console.log(`[register] Post-injection error: ${err}`);
    }
  }
  if (!solved) {
    await s.saveAccount('github', { username: id.username, email: id.email, password: id.password, status: 'captcha_blocked' });
    console.log(`IP_FLAGGED: captcha blocked — saved status=captcha_blocked: ${id.username} — rotate and retry`); await s.close().catch(()=>{}); process.exit(42);
  }

  // Email OTP
  const resendKey = process.env.RESEND_RECEIVING_API_KEY;
  const emailAddr = s.resolveEnv('$GITHUB_NEW_EMAIL');
  console.log(`[register] Polling for OTP to ${emailAddr}...`);
  let otp = null;
  for (let poll = 0; poll < 20 && !otp; poll++) {
    await s.wait(5);
    const emails = await (await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${resendKey}` } })).json();
    for (const em of emails.data ?? []) {
      const to = (em.to ?? []).map(t => typeof t === 'string' ? t : t.email).join(',');
      if (!to.includes(emailAddr) || !em.from?.toLowerCase().includes('github')) continue;
      const full = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${resendKey}` } })).json();
      const body = (full.html ?? '') + (full.text ?? '');
      const m = body.match(/\b(\d{6,8})\b/);
      if (m) { otp = m[1]; break; }
    }
  }
  if (!otp) {
    await s.saveAccount('github', { username: id.username, email: id.email, password: id.password, status: 'unverified' });
    console.log(`FAIL: no OTP — saved unverified: ${id.username}`); process.exit(1);
  }
  console.log(`[register] OTP: ${otp}`);

  const entered = await s.page.evaluate(`(code => {
    const inputs = document.querySelectorAll('input[autocomplete="one-time-code"], input[name*="code"], input[inputmode="numeric"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    if (inputs.length === 1) { setter.call(inputs[0], code); inputs[0].dispatchEvent(new Event('input', {bubbles:true})); return 'single'; }
    if (inputs.length >= code.length) {
      for (let i = 0; i < code.length; i++) { setter.call(inputs[i], code[i]); inputs[i].dispatchEvent(new Event('input', {bubbles:true})); }
      return 'split';
    }
    return 'none';
  })(${JSON.stringify(otp)})`).catch(() => 'error');
  console.log(`[register] OTP entered: ${entered}`);
  await s.wait(5);

  const finalUrl = s.page.url?.() ?? '';
  const verified = !finalUrl.includes('signup') && !finalUrl.includes('verify');
  await s.saveAccount('github', { username: id.username, email: id.email, password: id.password, status: verified ? 'verified' : 'needs_verification' });
  if (verified) await autoBindCharacter(id.username, 'github').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
  console.log(verified ? `PASS: ${id.username} (verified)` : `PARTIAL: ${id.username} at ${finalUrl}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200)); process.exit(/ERR_TUNNEL|ERR_TIMED_OUT|ERR_PROXY|ERR_CONNECTION/.test(e.message ?? '') ? 42 : 1);
} finally {
  await s.close();
}
