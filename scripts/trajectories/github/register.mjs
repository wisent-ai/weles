import { WSession } from '../../../dist/session/wsession.js';

const URL = 'https://github.com/signup';

let s;
for (let retry = 0; retry < 3; retry++) {
  try {
    s = await WSession.start({ label: 'github_register', proxy: process.env.PROXY_URL || 'residential' });
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
  s.ctx.on('request', (req) => {
    try {
      const u = req.url();
      if (u.includes('arkoselabs.com') || u.includes('octocaptcha.com')) {
        seenArkoseUrls.push(u.slice(0, 150));
        if (u.includes('arkoselabs.com/fc/gt2/public_key')) {
          const m = u.match(/public_key\/([A-F0-9-]+)/i);
          if (m) captcha.pkey = m[1];
          captcha.apiSub = new globalThis.URL(u).hostname;
          const body = req.postData() ?? '';
          const b = body.match(/data%5Bblob%5D=([^&]+)/);
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

  await s.fill('Email', '$GITHUB_NEW_EMAIL'); await s.wait(1);
  await s.fill('Password', '$GITHUB_NEW_PASSWORD'); await s.wait(1);
  await s.fill('Username', '$GITHUB_NEW_USERNAME'); await s.wait(3);

  // Country: check if already selected (auto-detected from proxy IP). If not, open dropdown + click US
  const countryState = await s.page.evaluate(`(() => {
    const btn = document.querySelector('#country-dropdown-panel-button, button.country-select-button');
    return { text: btn?.innerText?.trim().slice(0, 60) ?? '', found: !!btn };
  })()`).catch(() => ({ found: false }));
  console.log(`[register] Country button: ${JSON.stringify(countryState)}`);
  if (countryState.found && !/united states|^us$/i.test(countryState.text)) {
    try {
      await s.page.locator('#country-dropdown-panel-button, button.country-select-button').first().click();
      await s.wait(1);
      const optClicked = await s.page.evaluate(`(() => {
        const opts = Array.from(document.querySelectorAll('[role="option"], li, button, a'));
        for (const o of opts) {
          const t = (o.innerText || o.textContent || '').trim();
          if (/^united states/i.test(t) && !/virgin/i.test(t) && !/minor/i.test(t)) { o.click(); return { clicked: true, text: t.slice(0, 40) }; }
        }
        return { clicked: false };
      })()`).catch(e => ({ error: e.message?.slice(0, 80) }));
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

  // Click "Create account" using Playwright locator (trusted event)
  const createBtnSelector = 'button.js-octocaptcha-load-captcha, button[type="submit"]:has-text("Create account")';
  let clicked = { via: null };
  try {
    const btn = s.page.locator(createBtnSelector).first();
    if (await btn.isVisible().catch(() => false)) {
      await btn.scrollIntoViewIfNeeded().catch(() => {});
      await s.wait(0.5);
      await btn.click();
      clicked.via = 'locator';
    } else {
      // Fall through: evaluate-based click
      const res = await s.page.evaluate(`(() => {
        for (const btn of Array.from(document.querySelectorAll('button'))) {
          const t = btn.innerText.trim().toLowerCase();
          if (t.includes('create account') && !t.includes('google') && !t.includes('apple')) {
            btn.scrollIntoView({block:'center'}); btn.focus(); btn.click();
            return { via: 'evaluate', text: btn.innerText.trim() };
          }
        }
        return { via: null };
      })()`);
      clicked = res;
    }
  } catch (e) { console.log(`[register] Create click error: ${e.message?.slice(0, 100)}`); }
  console.log(`[register] Create account click: ${JSON.stringify(clicked)}`);
  await s.screenshot('after_create_account_click').catch(() => {});

  // Wait for captcha iframe to materialize — longer window, log progress
  for (let i = 0; i < 60 && !(captcha.pkey && captcha.blob); i++) {
    if (i % 10 === 0) console.log(`[register] Waiting captcha... ${i}s (arkose urls seen: ${seenArkoseUrls.length}, pkey=${captcha.pkey ? 'Y' : 'N'}, blob=${captcha.blob ? 'Y' : 'N'})`);
    await s.wait(1);
  }
  console.log(`[register] Arkose URLs intercepted (${seenArkoseUrls.length}):`);
  for (const u of seenArkoseUrls.slice(0, 15)) console.log(`  - ${u}`);

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
    captcha.pkey = '747B83EC-2CA3-43AD-A7DF-701F286FBABA';
    console.log('[register] Using known GitHub FunCaptcha sitekey');
  }
  if (!captcha.apiSub) captcha.apiSub = 'github-api.arkoselabs.com';
  console.log(`[register] Captcha: pkey=${captcha.pkey?.slice(0, 20)} blob=${captcha.blob?.slice(0, 30) ?? 'none'} sub=${captcha.apiSub}`);

  const proxy = s.proxyConfig;
  const ua = await s.page.evaluate('navigator.userAgent').catch(() => '');
  const proxyFields = {};
  if (proxy) {
    const u = new globalThis.URL(proxy.server);
    let gwIp = u.hostname;
    try { const dns = await import('node:dns'); gwIp = await new Promise((res, rej) => dns.lookup(u.hostname, (e, a) => e ? rej(e) : res(a))); } catch {}
    Object.assign(proxyFields, { proxyType: 'http', proxyAddress: gwIp, proxyPort: parseInt(u.port, 10), proxyLogin: proxy.username, proxyPassword: proxy.password });
  }
  const taskType = proxy ? 'FunCaptchaTask' : 'FunCaptchaTaskProxyless';
  const services = [
    { name: 'anticaptcha', url: 'https://api.anti-captcha.com', envKey: 'ANTICAPTCHA_API_KEY' },
    { name: 'capsolver', url: 'https://api.capsolver.com', envKey: 'CAPSOLVER_API_KEY' },
    { name: '2captcha', url: 'https://api.2captcha.com', envKey: 'TWOCAPTCHA_API_KEY' },
  ];

  let solved = false;
  for (const svc of services) {
    const apiKey = process.env[svc.envKey];
    if (!apiKey) { console.log(`[register] Skipping ${svc.name}: no key`); continue; }
    console.log(`[register] Trying ${svc.name}...`);
    const task = { type: taskType, websiteURL: URL, websitePublicKey: captcha.pkey,
      funcaptchaApiJSSubdomain: captcha.apiSub ?? 'github-api.arkoselabs.com', userAgent: ua, ...proxyFields };
    if (captcha.blob) task.data = JSON.stringify({ blob: captcha.blob });

    const cr = await (await fetch(svc.url + '/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, task }) })).json();
    if (cr.errorId) { console.log(`[register] ${svc.name} create error: ${cr.errorCode} ${cr.errorDescription?.slice(0, 80)}`); continue; }
    console.log(`[register] ${svc.name} taskId=${cr.taskId}`);
    let token = null;
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const res = await (await fetch(svc.url + '/getTaskResult', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, taskId: cr.taskId }) })).json();
      if (res.status === 'ready') { token = res.solution?.token ?? res.solution?.gRecaptchaResponse; break; }
      if (res.errorId) { console.log(`[register] ${svc.name} error: ${res.errorCode}`); break; }
    }
    if (!token) { console.log(`[register] ${svc.name}: no token`); continue; }
    console.log(`[register] ${svc.name} token: ${token.slice(0, 30)}...`);

    const inject = await s.page.evaluate(`(tk => {
      const inputs = document.querySelectorAll('input[name="octocaptcha-token"], input.js-octocaptcha-token');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const inp of inputs) { setter.call(inp, tk); inp.dispatchEvent(new Event('input', {bubbles:true})); inp.dispatchEvent(new Event('change', {bubbles:true})); }
      const cont = document.querySelector('[data-octocaptcha-token]');
      if (cont) cont.dataset.octocaptchaToken = tk;
      window.dispatchEvent(new CustomEvent('octocaptcha:solved', { detail: { token: tk } }));
      const btn = document.querySelector('.js-octocaptcha-form-submit');
      if (btn) { btn.click(); return { injected: inputs.length, clicked: true }; }
      const form = document.querySelector('form.js-octocaptcha-parent, form[data-octo-click-hmac]');
      if (form) { form.requestSubmit?.(); return { injected: inputs.length, clicked: 'form' }; }
      return { injected: inputs.length, clicked: false };
    })(${JSON.stringify(token)})`).catch(e => ({ error: e.message }));
    console.log(`[register] Token injection: ${JSON.stringify(inject)}`);

    await s.wait(5);
    const url2 = s.page.url?.() ?? '';
    if (url2.includes('signup_emailsent') || url2.includes('verify') || url2.includes('launch-code')) {
      console.log(`[register] Captcha accepted at ${url2}`);
      solved = true; break;
    }
    const err = await s.page.evaluate("(() => { const e=document.querySelector('.flash-error,[role=\"alert\"]'); return e?e.innerText.trim().slice(0,200):null; })()").catch(() => null);
    if (err) console.log(`[register] ${svc.name} error: ${err}`);
  }

  if (!solved) {
    await s.saveAccount('github', { username: id.username, email: id.email, password: id.password, status: 'captcha_blocked' });
    console.log(`FAIL: captcha blocked — account saved status=captcha_blocked: ${id.username}`);
    process.exit(1);
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
  console.log(verified ? `PASS: ${id.username} (verified)` : `PARTIAL: ${id.username} at ${finalUrl}`);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
