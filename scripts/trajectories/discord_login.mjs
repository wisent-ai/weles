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
// Use the same proxy the account was registered with (same IP = no location verification)
const savedProxy = acct.metadata.proxy;
let proxyUrl = process.env.PROXY_URL || 'residential';
if (savedProxy?.server && savedProxy?.username) {
  const u = new globalThis.URL(savedProxy.server);
  proxyUrl = `${u.protocol}//${savedProxy.username}:${savedProxy.password}@${u.hostname}:${u.port}`;
  console.log(`[trajectory] Using saved proxy: ${u.hostname}:${u.port} sessid=${savedProxy.username.match(/sessid-(\d+)/)?.[1]}`);
}
console.log(`[trajectory] Using account: ${acct.username} (${process.env.SVC_EMAIL})`);

let s;
for (let retry = 0; retry < 3; retry++) {
  try {
    s = await WSession.start({ label: 'discord_login', proxy: proxyUrl });
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
try {
  await s.fill('Email or Phone Number', '$SVC_EMAIL');
  await s.fill('Password', '$SVC_PASSWORD');
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
    const proxyFields = u ? { proxyType: 'http', proxyAddress: u.hostname, proxyPort: parseInt(u.port, 10), proxyLogin: proxy.username, proxyPassword: proxy.password } : {};
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
      for (let attempt = 0; attempt < 3; attempt++) {
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
        console.log(`[login] ${svc.name} attempt ${attempt + 1}: status=${result?.status} response=${JSON.stringify(result?.data).slice(0, 200)}`);
        if (result?.status === 200 && result?.data?.token) {
          console.log(`[login] SUCCESS — token received`);
          await s.page.evaluate(`localStorage.setItem("token", JSON.stringify(${JSON.stringify(result.data.token)}))`).catch(() => {});
          await s.goto('https://discord.com/channels/@me');
          await s.wait(5);
          console.log(`PASS: logged in as ${acct.username} — ${s.page.url?.()}`);
          loggedIn = true; break;
        }
        if (result?.data?.captcha_rqdata) { currentRqdata = result.data.captcha_rqdata; currentRqtoken = result.data.captcha_rqtoken; console.log('[login] Updated captcha data, retrying...'); continue; }
        // Login location verification — fetch email link and verify
        if (result?.data?.errors?.login?._errors?.some(e => e.code === 'ACCOUNT_LOGIN_VERIFICATION_EMAIL')) {
          console.log('[login] New location verification required, checking email...');
          const resendKey = process.env.RESEND_RECEIVING_API_KEY;
          const email = formData.login;
          for (let poll = 0; poll < 15; poll++) {
            await new Promise(r => setTimeout(r, 5000));
            const emails = await (await fetch('https://api.resend.com/emails/receiving?limit=5', { headers: { Authorization: `Bearer ${resendKey}` } })).json();
            for (const em of emails.data || []) {
              const to = (em.to || []).map(t => typeof t === 'string' ? t : t.email).join(',');
              if (!to.includes(email) || !em.subject?.includes('Login')) continue;
              const full = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${resendKey}` } })).json();
              const links = (full.html || '').match(/https:\/\/click\.discord\.com[^\s"]+/g);
              if (links?.length) {
                console.log(`[login] Found verify link, navigating...`);
                await s.goto(links[0]);
                await s.wait(5);
                console.log(`[login] After verify: ${s.page.url?.()}`);
                // Retry login after verification
                attempt = -1; // Reset to retry from scratch
                poll = 999; // Exit poll loop
                break;
              }
            }
          }
          continue;
        }
        break;
      }
      if (loggedIn) break;
    }
  } else {
    // No captcha — check if already logged in
    const url2 = s.page.url?.() ?? '';
    console.log(url2.includes('/channels') ? 'PASS: logged in' : `FAIL: no captcha data, stuck at ${url2}`);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
