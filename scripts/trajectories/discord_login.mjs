import { getSocialAccount } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://discord.com/login';
const GOAL = `Fill username/email with $SVC_EMAIL and password with $SVC_PASSWORD. Click Log In or Sign In. Wait for redirect. done(value="logged in").`;

const acct = await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no active discord account in DB'); process.exit(1); }
if (!acct.metadata.password) { console.log(`FAIL: account ${acct.username} has no password`); process.exit(1); }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password;
// Use the same proxy provider but with a fresh sticky session (old sessid expired)
const savedProxy = acct.metadata.proxy;
let proxyUrl = process.env.PROXY_URL || 'residential';
if (savedProxy?.server && savedProxy?.username) {
  const u = new globalThis.URL(savedProxy.server);
  // Generate new sticky session ID for the same provider
  const newSessId = Math.floor(Math.random() * 9000000 + 1000000);
  // Always use cc-us for login (Brazilian IPs get Cloudflare JS challenge on login page)
  const newUsername = savedProxy.username.replace(/sessid-\d+/, `sessid-${newSessId}`).replace(/cc-[a-z]{2}/, 'cc-us');
  proxyUrl = `${u.protocol}//${newUsername}:${savedProxy.password}@${u.hostname}:${u.port}`;
  console.log(`[trajectory] Using saved proxy provider: ${u.hostname}:${u.port} new sessid=${newSessId}`);
}
console.log(`[trajectory] Using account: ${acct.username} (${process.env.SVC_EMAIL})`);

let s;
for (let retry = 0; retry < 3; retry++) {
  try {
    s = await WSession.start({ label: 'discord_login', proxy: proxyUrl });
    // Visit register page first to pass Cloudflare challenge and set cf_clearance cookie
    await s.goto('https://discord.com/register');
    await s.wait(3);
    await s.goto(URL);
    let mounted = false;
    for (let i = 0; i < 15; i++) { if (await s.page.evaluate('document.querySelector("#app-mount")?.children?.length > 0').catch(() => false)) { mounted = true; break; } await s.wait(1); }
    if (mounted) { console.log(`[login] SPA mounted on attempt ${retry + 1}`); break; }
    console.log(`[login] SPA failed to mount on attempt ${retry + 1}, retrying...`);
  } catch (e) { console.log(`[login] Attempt ${retry + 1} crashed: ${e.message?.slice(0, 100)}`); }
  await s?.close().catch(() => {});
  s = null;
}
if (!s) { console.log('FAIL: SPA never mounted after 3 attempts'); process.exit(1); }

async function captureCookies() {
  if (!acct.id) return;
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!supabaseUrl || !key) return;
  try {
    const cookies = await s.ctx.cookies();
    const r = await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${acct.id}&select=metadata`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
    const rows = await r.json();
    const merged = { ...(rows?.[0]?.metadata ?? {}), cookies };
    await fetch(`${supabaseUrl}/rest/v1/social_accounts?id=eq.${acct.id}`, {
      method: 'PATCH',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ metadata: merged }),
    });
    console.log(`[cookie-capture] refreshed ${cookies.length} cookies for account ${acct.id}`);
  } catch (e) { console.log('[cookie-capture] err:', e.message); }
}

try {
  // Wait for login form to render (SPA mount != form ready)
  for (let i = 0; i < 30; i++) {
    const hasInputs = await s.page.evaluate('document.querySelectorAll("input").length > 0').catch(() => false);
    if (hasInputs) { console.log(`[login] Form inputs appeared after ${i + 1}s`); break; }
    await s.wait(1);
  }
  // Discover input names
  const inputNames = await s.page.evaluate(`(() => {
    return Array.from(document.querySelectorAll('input')).map(i => ({ name: i.name, type: i.type, ph: i.placeholder, aria: i.getAttribute('aria-label') }));
  })()`).catch(() => []);
  console.log(`[login] Inputs: ${JSON.stringify(inputNames)}`);
  // Use JS value setter (Playwright el.fill fails on Discord's React inputs)
  const fillField = async (selector, val) => {
    return s.page.evaluate(`(({ sel, val }) => {
      const el = document.querySelector(sel);
      if (!el) return { ok: false, reason: 'not-found', sel };
      el.focus();
      const originalType = el.type;
      if (originalType === 'password') el.type = 'text';
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (originalType === 'password') el.type = originalType;
      return { ok: true, len: val.length };
    })(${JSON.stringify({ sel: selector, val })})`);
  };
  // Find email input (could be name="email", name="login", or type="email")
  const emailSel = inputNames.find(i => i.name === 'email' || i.type === 'email' || i.name === 'login')
    ? `input[name="${inputNames.find(i => i.name === 'email' || i.type === 'email' || i.name === 'login').name}"]`
    : 'input[type="email"], input[name="email"], input[name="login"]';
  const passSel = inputNames.find(i => i.type === 'password' || i.name === 'password')
    ? `input[name="${inputNames.find(i => i.type === 'password' || i.name === 'password').name}"]`
    : 'input[type="password"]';
  const emailResult = await fillField(emailSel, process.env.SVC_EMAIL);
  const passResult = await fillField(passSel, process.env.SVC_PASSWORD);
  console.log(`[login] fill email(${emailSel}): ${JSON.stringify(emailResult)}, password(${passSel}): ${JSON.stringify(passResult)}`);
  await s.wait(1);
  // Submit and wait for captcha interception
  for (let attempt = 0; attempt < 5; attempt++) {
    console.log(`[login] Submit attempt ${attempt + 1}`);
    await s.page.locator('button[type="submit"]').click().catch(e => console.log(`[login] locator click failed: ${e.message?.slice(0, 80)}`));
    await s.wait(2);
    if (s.captchaResponse) { console.log('[login] Captcha intercepted after locator click'); break; }
    await s.page.evaluate('document.querySelector("form")?.requestSubmit()').catch(e => console.log(`[login] requestSubmit failed: ${e.message?.slice(0, 80)}`));
    await s.wait(2);
    if (s.captchaResponse) { console.log('[login] Captcha intercepted after requestSubmit'); break; }
  }
  // Solve captcha and resubmit via API (same as registration)
  const captchaData = s.captchaResponse;
  const formData = s.captchaFormData;
  const proxy = s.proxyConfig;
  if (captchaData && formData) {
    const ua = await s.page.evaluate('navigator.userAgent').catch(() => '');
    const u = proxy ? new globalThis.URL(proxy.server) : null;
    let gwIp = u?.hostname;
    if (gwIp) { try { const dns = await import('node:dns'); gwIp = await new Promise((res, rej) => dns.lookup(gwIp, (e, a) => e ? rej(e) : res(a))); } catch {} }
    const proxyFields = u ? { proxyType: 'http', proxyAddress: gwIp, proxyPort: parseInt(u.port, 10), proxyLogin: proxy.username, proxyPassword: proxy.password } : {};
    console.log(`[login] Proxy for captcha: ${gwIp}:${u?.port} user=${proxy.username?.slice(0, 30)}`);
    const services = [
      { name: 'anticaptcha', url: 'https://api.anti-captcha.com', envKey: 'ANTICAPTCHA_API_KEY' },
      { name: 'capsolver', url: 'https://api.capsolver.com', envKey: 'CAPSOLVER_API_KEY' },
    ];
    for (const svc of services) {
      const apiKey = process.env[svc.envKey];
      if (!apiKey) continue;
      console.log(`[login] formData: login=${formData.login} pass=${formData.password ? '***(' + formData.password.length + ')' : 'EMPTY'}`);
      let currentRqdata = captchaData.captcha_rqdata;
      let currentRqtoken = captchaData.captcha_rqtoken;
      let loggedIn = false;
      for (let attempt = 0; attempt < 5; attempt++) {
        const taskType = u ? 'HCaptchaTask' : 'HCaptchaTaskProxyless';
        const task = { type: taskType, websiteURL: 'https://discord.com/login', websiteKey: captchaData.captcha_sitekey, isEnterprise: true, enterprisePayload: { rqdata: currentRqdata }, userAgent: ua, ...proxyFields };
        const cr = await (await fetch(svc.url + '/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, task }) })).json();
        if (cr.errorId) { console.log(`[login] ${svc.name} error: ${cr.errorCode}`); break; }
        console.log(`[login] ${svc.name} attempt ${attempt + 1} solving...`);
        let token = null;
        for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 5000)); const res = await (await fetch(svc.url + '/getTaskResult', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, taskId: cr.taskId }) })).json(); if (res.status === 'ready') { token = res.solution?.gRecaptchaResponse ?? res.solution?.token; break; } if (res.errorId) break; }
        if (!token) { console.log(`[login] ${svc.name} solve failed`); break; }
        formData.captcha_key = token;
        if (currentRqtoken) formData.captcha_rqtoken = currentRqtoken;
        const hdrs = JSON.stringify({ 'Content-Type': 'application/json', ...s.captchaHeaders });
        const result = await s.page.evaluate(`(async()=>{var r=await fetch('/api/v9/auth/login',{method:'POST',headers:${hdrs},body:${JSON.stringify(JSON.stringify(formData))}});return{status:r.status,data:await r.json().catch(()=>({}))};})()`).catch(e => ({ error: e.message }));
        console.log(`[login] ${svc.name} attempt ${attempt + 1}: status=${result?.status} response=${(JSON.stringify(result?.data) ?? '').slice(0, 200)}`);
        if (result?.status === 200 && result?.data?.token) {
          console.log(`[login] SUCCESS — token received`);
          await s.page.evaluate(`localStorage.setItem("token", JSON.stringify(${JSON.stringify(result.data.token)}))`).catch(() => {});
          // Persist the token into metadata.discord_token alongside cookies so
          // the health probe (and future action trajectories) can re-inject it.
          // Cookies alone don't auth Discord — the token lives in localStorage,
          // and without it every /channels/@me nav bounces to /login.
          if (acct.id && process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
            const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
            const url = process.env.SUPABASE_URL;
            fetch(`${url}/rest/v1/social_accounts?id=eq.${acct.id}&select=metadata`, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
              .then(r => r.json())
              .then(rows => fetch(`${url}/rest/v1/social_accounts?id=eq.${acct.id}`, {
                method: 'PATCH',
                headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({ metadata: { ...(rows?.[0]?.metadata ?? {}), discord_token: result.data.token } }),
              })).catch(() => {});
          }
          await s.goto('https://discord.com/channels/@me');
          await s.wait(5);
          console.log(`PASS: logged in as ${acct.username} — ${s.page.url?.()}`);
          await captureCookies();
          loggedIn = true; break;
        }
        if (result?.data?.captcha_rqdata) { currentRqdata = result.data.captcha_rqdata; currentRqtoken = result.data.captcha_rqtoken; console.log('[login] Updated captcha data, retrying...'); continue; }
        // Login location verification — click verify link, go back to login, re-submit through the form
        if (result?.data?.errors?.login?._errors?.some(e => e.code === 'ACCOUNT_LOGIN_VERIFICATION_EMAIL')) {
          console.log('[login] New location verification required, checking email...');
          const resendKey = process.env.RESEND_RECEIVING_API_KEY;
          const email = formData.login;
          const loginAttemptTs = Date.now() - 30000; // 30s buffer
          let verifyDone = false;
          for (let poll = 0; poll < 15 && !verifyDone; poll++) {
            await new Promise(r => setTimeout(r, 5000));
            const emails2 = await (await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${resendKey}` } })).json();
            for (const em of emails2.data || []) {
              const to = (em.to || []).map(t => typeof t === 'string' ? t : t.email).join(',');
              if (!to.includes(email) || !em.subject?.includes('Login')) continue;
              // Only accept emails newer than this login attempt
              if (new Date(em.created_at).getTime() < loginAttemptTs) { continue; }
              const full2 = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${resendKey}` } })).json();
              const links = (full2.html || '').match(/https:\/\/click\.discord\.com[^\s"]+/g);
              if (links?.length) {
                // Find the authorize-ip link (not reject-ip or generic links)
                let authorizeLink = null;
                for (const link of links) {
                  const resp = await fetch(link, { redirect: 'manual' });
                  const loc = resp.headers.get('location') || '';
                  if (loc.includes('authorize-ip')) { authorizeLink = loc; break; }
                }
                if (!authorizeLink) { console.log('[login] No authorize-ip link found in email'); continue; }
                console.log(`[login] Found authorize-ip link, opening in new tab...`);
                const newPage = await s.ctx.newPage();
                // Listen for the authorize-ip API call
                let apiCalled = false;
                newPage.on('response', async (resp) => {
                  if (resp.url().includes('authorize-ip') && resp.request().method() === 'POST') {
                    console.log(`[login] authorize-ip API: ${resp.status()}`);
                    apiCalled = true;
                  }
                });
                await newPage.goto(authorizeLink, { waitUntil: 'domcontentloaded' }).catch(() => {});
                // Wait for the SPA to mount and call the authorize-ip API
                for (let w = 0; w < 30 && !apiCalled; w++) { await new Promise(r => setTimeout(r, 1000)); }
                const verifyUrl = newPage.url();
                console.log(`[login] Authorize tab: ${verifyUrl?.slice(0, 80)} apiCalled=${apiCalled}`);
                await newPage.close().catch(() => {});
                await s.wait(2);
                verifyDone = true;
                break;
              }
            }
          }
          if (!verifyDone) { console.log('[login] No verify email found'); break; }
          // Reload login page fresh, re-fill, re-submit to get new captcha
          console.log('[login] IP authorized, reloading login page...');
          await s.goto('https://discord.com/login');
          for (let i = 0; i < 15; i++) {
            if (await s.page.evaluate('document.querySelectorAll("input").length > 0').catch(() => false)) break;
            await s.wait(1);
          }
          await fillField(emailSel, process.env.SVC_EMAIL);
          await fillField(passSel, process.env.SVC_PASSWORD);
          await s.wait(1);
          s.captchaResponse = null;
          s.captchaFormData = null;
          await s.page.locator('button[type="submit"]').click().catch(() => {});
          await s.wait(5);
          if (s.captchaResponse) {
            currentRqdata = s.captchaResponse.captcha_rqdata;
            currentRqtoken = s.captchaResponse.captcha_rqtoken;
            Object.assign(formData, s.captchaFormData);
            console.log('[login] New captcha after authorize-ip, solving...');
            continue;
          }
          const postUrl = s.page.url?.() ?? '';
          if (postUrl.includes('/channels')) {
            console.log(`PASS: logged in as ${acct.username} — ${postUrl}`);
            await captureCookies();
            loggedIn = true; break;
          }
          console.log(`[login] After authorize re-submit: ${postUrl}, no captcha`);
          break;
        }
        break;
      }
      if (loggedIn) break;
    }
  } else {
    // No captcha — check if already logged in
    const url2 = s.page.url?.() ?? '';
    if (url2.includes('/channels')) {
      console.log('PASS: logged in');
      await captureCookies();
    } else {
      console.log(`FAIL: no captcha data, stuck at ${url2}`);
    }
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
