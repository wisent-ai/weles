import { WSession } from '../../../dist/session/wsession.js';
import { solveFunCaptcha } from './captcha/funcaptcha.mjs';
import { solveAudioPuzzle } from './captcha/audio_solver.mjs';
import { solveRotationViaCoords } from './captcha/coords_solver.mjs';
import { requireStadoModelRouterConfig } from './captcha/stado_model_router.mjs';
import { humanClick, humanClickLocator } from '../../../dist/human/mouse.js'; import { humanType } from '../../../dist/human/keyboard.js';
import { autoBindCharacter } from '../lib/character-bind.mjs';
import { getReceived, listReceivedFrom } from '../../_shared/resend-receiving.mjs';

const URL = 'https://github.com/signup';

// One session, started once: a homepage that does not render is this run's
// failure with its own cause, not a cue to try a set number of times. No OS
// pin — persona OS rolls naturally. en-US locale pins language +
// accept-language headers to match US proxy geolocation.
const s = await WSession.start({ label: 'github_register', proxy: process.env.PROXY_URL || 'residential', locale: 'en-US' });
await s.goto('https://github.com/');
// The page says when it has rendered; the trajectory waits for that, not
// for a counted number of seconds.
await s.page.waitForFunction('document.readyState === "complete" && document.body && document.body.innerText.length > 0', null, { timeout: 0 });
console.log('[register] Homepage rendered');

try {
  const id = await s.generateIdentity('github');
  console.log(`[register] Identity: username=${id.username} email=${id.email}`);

  // Intercept Arkose/FunCaptcha public_key + blob (context-level catches iframe requests)
  const captcha = { blob: null, pkey: null, apiSub: null };
  const seenArkoseUrls = [];
  const seenGithubPosts = [];
  let captchaLoaded;
  const captchaReady = new Promise((resolve) => { captchaLoaded = resolve; });
  s.ctx.on('request', (req) => {
    try {
      const u = req.url();
      if (req.method() === 'POST' && u.includes('github.com') && !u.includes('analytics') && !u.includes('_metric')) {
        seenGithubPosts.push(`${u} body=${(req.postData() ?? '')}`);
      }
      if (u.includes('arkoselabs.com') || u.includes('octocaptcha.com')) {
        seenArkoseUrls.push(u);
        if (u.includes('arkoselabs.com/fc/gt2/public_key')) {
          const m = u.match(/public_key\/([A-F0-9-]+)/i);
          if (m) captcha.pkey = m[1];
          captcha.apiSub = new globalThis.URL(u).hostname;
          const body = req.postData() ?? '';
          const b = body.match(/data%5Bblob%5D=([^&]+)/) ?? body.match(/data\[blob\]=([^&]+)/);
          if (b) { captcha.blob = decodeURIComponent(b[1]); captchaLoaded(); }
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
  await s.page.locator('#email').first().waitFor({ state: 'visible', timeout: 0 });
  console.log(`[register] Signup page: ${s.page.url?.()}`);

  const fillField = async (selector, value) => {
    const expected = s.resolveEnv(value);
    const field = s.page.locator(selector).first();
    const editable = field.and(s.page.locator('input:enabled:not([readonly])'));
    await editable.waitFor({ state: 'visible' });
    await humanClickLocator(s.page, editable);
    await humanType(s.page, expected);
    const actual = await field.inputValue();
    if (actual !== expected) {
      throw new Error(`fillField(${selector}): value mismatch after input dispatch; observed length=${actual.length}, expected length=${expected.length}`);
    }
    await s.page.keyboard.press('Tab');
    console.log(`[register] Filled and verified ${selector}`);
  };
  await fillField('#email', '$GITHUB_NEW_EMAIL');
  await fillField('#password', '$GITHUB_NEW_PASSWORD');
  await fillField('#login', '$GITHUB_NEW_USERNAME');

  // Country: check if auto-selected (usually from proxy IP). Only click dropdown if needed.
  const countryState = await s.page.evaluate(`(() => { const btn = document.querySelector('#country-dropdown-panel-button, button.country-select-button'); return { text: btn ? btn.innerText.trim() : '', found: !!btn }; })()`).catch(() => ({ found: false }));
  console.log(`[register] Country button: ${JSON.stringify(countryState)}`);
  if (countryState.found && !/united states|^us$/i.test(countryState.text)) {
    try {
      await humanClickLocator(s.page, s.page.locator('#country-dropdown-panel-button, button.country-select-button').first());
      await s.page.locator('[role="option"], li, button, a').filter({ hasText: /united states/i }).first().waitFor({ state: 'visible', timeout: 0 });
      // Pick the "United States" option via a trusted locator click. Re-check
      // innerText to exclude 'Virgin' / 'Minor' variants (hasText is substring).
      const all = await s.page.locator('[role="option"], li, button, a').filter({ hasText: /united states/i }).all().catch(() => []);
      let optClicked = { clicked: false };
      for (const el of all) { const t = ((await el.innerText().catch(() => '')) ?? '').trim(); if (/^united states/i.test(t) && !/virgin/i.test(t) && !/minor/i.test(t)) { await humanClickLocator(s.page, el).catch(() => {}); optClicked = { clicked: true, text: t }; break; } }
      console.log(`[register] Country option click: ${JSON.stringify(optClicked)}`);
    } catch (e) { console.log(`[register] Country click error: ${e.message}`); }
  } else {
    console.log('[register] Country auto-selected — skipping');
  }

  // The three validators mark their fields when they pass; wait for that mark.
  await s.page.waitForFunction(`['#email', '#password', '#login'].every((field) => document.querySelector(field)?.classList?.contains('is-autocheck-successful'))`, null, { timeout: 0 });
  console.log('[register] All autochecks successful');

  // Click "Create account" via humanClick (Bezier path, isTrusted=true)
  const createBtnSelector = 'button.js-octocaptcha-load-captcha, button[type="submit"]:has-text("Create account")';
  let clicked = { via: null };
  try {
    const btn = s.page.locator(createBtnSelector).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.scrollIntoViewIfNeeded();
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
  } catch (e) { console.log(`[register] Create click error: ${e.message}`); }
  console.log(`[register] Create account click: ${JSON.stringify(clicked)}`);
  await s.screenshot('after_create_account_click').catch(() => {});

  // The captcha frame appears with the click; load it if GitHub left it
  // unloaded, acknowledge it (require_ack=true) so the inner Arkose widget
  // loads, then wait for the widget's own public_key request to carry the blob.
  await s.page.locator('iframe.js-octocaptcha-frame').first().waitFor({ state: 'attached', timeout: 0 });
  if (seenArkoseUrls.length === 0) {
    const forced = await s.page.evaluate(`(() => { const f = document.querySelector('iframe.js-octocaptcha-frame'); if (!f) return { ok: false, reason: 'no-frame' }; const ds = f.getAttribute('data-src'); if (f.getAttribute('src')?.length > 10) return { ok: true, reason: 'already-loaded' }; if (ds) { f.setAttribute('src', ds); return { ok: true, reason: 'forced' }; } return { ok: false, reason: 'no-data-src' }; })()`).catch(() => ({ ok: false, reason: 'eval-error' }));
    console.log(`[register] Force iframe: ${JSON.stringify(forced)}`);
  }
  const ackRes = await s.page.evaluate(`(() => { const f = document.querySelector('iframe.js-octocaptcha-frame'); if (!f?.contentWindow) return { ok: false, reason: 'no-content-window' }; for (const msg of [{ type: 'ack', acked: true }, 'ack', { event: 'ack' }, { type: 'octocaptcha:ack' }]) { try { f.contentWindow.postMessage(msg, 'https://octocaptcha.com'); } catch {} try { f.contentWindow.postMessage(msg, '*'); } catch {} } return { ok: true }; })()`).catch(() => ({ ok: false }));
  console.log(`[register] postMessage ack: ${JSON.stringify(ackRes)}`);
  await captchaReady;
  console.log(`[register] Arkose URLs (${seenArkoseUrls.length}):`);
  for (const u of seenArkoseUrls) console.log(`  - ${u}`);
  console.log(`[register] GitHub POSTs during flow (${seenGithubPosts.length}):`);
  for (const p of seenGithubPosts) console.log(`  - ${p}`);

  // DOM-based extraction of pkey from iframe (data-src becomes src after load)
  if (!captcha.pkey) {
    const iframeInfo = await s.page.evaluate(`(() => {
      const frames = Array.from(document.querySelectorAll('iframe'));
      return frames.map(f => ({ src: f.src, dataSrc: f.getAttribute('data-src'), cls: f.className })).filter(f => f.src || f.dataSrc);
    })()`).catch(() => []);
    console.log(`[register] All iframes: ${JSON.stringify(iframeInfo)}`);
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
  console.log(`[register] Captcha: pkey=${captcha.pkey} blob=${captcha.blob ?? 'none'} sub=${captcha.apiSub}`);

  const ua = await s.page.evaluate('navigator.userAgent').catch(() => '');

  let solved = false;
  // The retired Bright Data Browser path depended on an ambient WebSocket
  // credential. Use only the provider-neutral Stado-backed solvers.
  requireStadoModelRouterConfig();
  // A solved captcha moves GitHub on to the email step; a refused one shows an
  // alert. Whichever the page shows first is the answer.
  const verdict = () => Promise.race([
    s.page.waitForURL(/signup_emailsent|verif|launch-code|account_verif/, { timeout: 0 }).then(() => true),
    s.page.locator('.flash-error, [role="alert"]').first().waitFor({ state: 'visible', timeout: 0 }).then(() => false),
  ]);
  for (const fn of [solveAudioPuzzle, solveRotationViaCoords]) {
    if (solved) break;
    const ok = await fn(s.page);
    if (ok) solved = await verdict();
  }
  // External solvers (anticaptcha/2captcha) return UNSOLVABLE on Arkose basket puzzles — opt-in only.
  const token = (solved || process.env.WELES_EXTERNAL_FUNCAPTCHA !== '1') ? null : (await solveFunCaptcha({ websiteURL: URL, publicKey: captcha.pkey, apiSub: captcha.apiSub, blob: captcha.blob, userAgent: ua, proxy: s.proxyConfig })).token;
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
    })(${JSON.stringify(token)})`).catch(e => ({ error: e.message }));
    console.log(`[register] Token injection: ${JSON.stringify(inject)} region=${token.match(/r=([^|&]+)/)?.[1] ?? '?'}`);
    solved = await verdict();
    if (solved) console.log(`[register] Captcha accepted at ${s.page.url?.() ?? ''}`);
    if (!solved) {
      const err = await s.page.evaluate("(() => { const e=document.querySelector('.flash-error,[role=\"alert\"]'); return e?e.innerText.trim():null; })()").catch(() => null);
      if (err) console.log(`[register] Post-injection error: ${err}`);
    }
  }
  if (!solved) {
    await s.saveAccount('github', { username: id.username, email: id.email, password: id.password, status: 'captcha_blocked' });
    console.log(`IP_FLAGGED: captcha blocked — saved status=captcha_blocked: ${id.username} — rotate and retry`); await s.close().catch(()=>{}); process.exit(42);
  }

  // Email OTP
  const emailAddr = s.resolveEnv('$GITHUB_NEW_EMAIL');
  console.log(`[register] Polling for OTP to ${emailAddr}...`);
  // The code arrives when GitHub sends it; the inbox is read until it does.
  let otp = null;
  while (!otp) {
    await s.wait(5);
    for (const em of await listReceivedFrom(10, emailAddr, 'github.com')) {
      const full = await getReceived(em.id);
      const body = (full.html ?? '') + (full.text ?? '');
      const m = body.match(/\b(\d{6,8})\b/);
      if (m) { otp = m[1]; break; }
    }
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
  await Promise.race([
    s.page.waitForURL((url) => !url.href.includes('signup') && !url.href.includes('verify'), { timeout: 0 }),
    s.page.locator('.flash-error, [role="alert"]').first().waitFor({ state: 'visible', timeout: 0 }),
  ]);

  const finalUrl = s.page.url?.() ?? '';
  const verified = !finalUrl.includes('signup') && !finalUrl.includes('verify');
  await s.saveAccount('github', { username: id.username, email: id.email, password: id.password, status: verified ? 'verified' : 'needs_verification' });
  if (verified) await autoBindCharacter(id.username, 'github').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message}`));
  console.log(verified ? `PASS: ${id.username} (verified)` : `PARTIAL: ${id.username} at ${finalUrl}`);
} catch (e) {
  console.error('FAIL:', e);
  process.exitCode = 1;
} finally {
  await s.close();
}
