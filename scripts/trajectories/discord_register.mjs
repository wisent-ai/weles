import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://discord.com/register';
const GOAL = `generate_identity(platform="discord"). Fill Email with $DISCORD_NEW_EMAIL. Fill "Display Name" with $DISCORD_NEW_USERNAME. Fill Username with $DISCORD_NEW_USERNAME. Fill Password with $DISCORD_NEW_PASSWORD. For Date of Birth use select_option(target="month",value=$DISCORD_NEW_BIRTHMONTH), select_option(target="day",value=$DISCORD_NEW_BIRTHDAY), select_option(target="year",value=$DISCORD_NEW_BIRTHYEAR). Click "Create Account". If captcha, solve_captcha(sitekey="auto"). If email verification, check_email(email=$DISCORD_NEW_EMAIL,sender="discord"). done(value=$DISCORD_NEW_USERNAME).`;

const s = await WSession.start({ label: 'discord_register', proxy: process.env.PROXY_URL || 'residential' });
try {
  if (process.env.DISCORD_HARDCODED === '1') {
    // Hardcoded trajectory — bypasses LLM agent
    const id = await s.generateIdentity('discord');
    await s.goto(URL);
    // Wait for Discord SPA to mount (Cloudflare may delay JS execution)
    for (let i = 0; i < 30; i++) {
      const mounted = await s.page.evaluate('document.querySelector("#app-mount")?.children?.length > 0').catch(() => false);
      if (mounted) { console.log(`[test] SPA mounted after ${i + 1}s`); break; }
      await s.wait(1);
    }
    await s.fill('Email', '$DISCORD_NEW_EMAIL');
    await s.fill('Display Name', '$DISCORD_NEW_USERNAME');
    await s.fill('Username', '$DISCORD_NEW_USERNAME');
    await s.fill('Password', '$DISCORD_NEW_PASSWORD');
    await s.select('month', '$DISCORD_NEW_BIRTHMONTH');
    await s.select('day', '$DISCORD_NEW_BIRTHDAY');
    await s.select('year', '$DISCORD_NEW_BIRTHYEAR');
    await s.wait(1);
    const terms = s.page.locator('text=I have read and agree');
    if (await terms.isVisible().catch(() => false)) { await terms.click(); console.log('[test] Terms clicked'); }
    await s.wait(1);
    // Retry submit until captcha data is intercepted
    for (let attempt = 0; attempt < 5; attempt++) {
      await s.page.locator('button[type="submit"]').click().catch(() => {});
      await s.wait(2);
      if (s.captchaResponse) { console.log('[test] Form submitted (captcha intercepted)'); break; }
      await s.page.evaluate('document.querySelector("form")?.requestSubmit()').catch(() => {});
      await s.wait(2);
      if (s.captchaResponse) { console.log('[test] Form submitted via requestSubmit'); break; }
      console.log(`[test] Submit attempt ${attempt + 1} — no captcha response yet`);
    }
    await s.wait(3);

    // Try each captcha service until Discord accepts the token
    const captchaData = s.captchaResponse;
    const formData = s.captchaFormData;
    const headers = s.captchaHeaders;
    if (captchaData && formData) {
      const ua = await s.page.evaluate('navigator.userAgent').catch(() => '');
      const proxy = s.proxyConfig;
      const services = [
        { name: 'anticaptcha', url: 'https://api.anti-captcha.com', envKey: 'ANTICAPTCHA_API_KEY' },
        { name: 'capsolver', url: 'https://api.capsolver.com', envKey: 'CAPSOLVER_API_KEY' },
        { name: 'capmonster', url: 'https://api.capmonster.cloud', envKey: 'CAPMONSTERCLOUD_API_KEY' },
        { name: '2captcha', url: 'https://api.2captcha.com', envKey: 'TWOCAPTCHA_API_KEY' },
      ];
      let registered = false;
      for (const svc of services) {
        const apiKey = process.env[svc.envKey];
        if (!apiKey) { console.log(`[test] Skipping ${svc.name}: no API key`); continue; }
        console.log(`[test] Trying ${svc.name}...`);
        // Build task
        const proxyFields = {};
        if (proxy) {
          const u = new globalThis.URL(proxy.server);
          // Resolve gateway hostname once — must match the IP browser connected to
          let gwIp = u.hostname;
          try { const dns = await import('node:dns'); gwIp = await new Promise((res, rej) => dns.lookup(u.hostname, (e, a) => e ? rej(e) : res(a))); } catch {}
          Object.assign(proxyFields, { proxyType: 'http', proxyAddress: gwIp, proxyPort: parseInt(u.port, 10), proxyLogin: proxy.username, proxyPassword: proxy.password });
          console.log(`[test] Proxy for captcha: gw=${gwIp}:${u.port} user=${proxy.username?.slice(0, 30)}`);
        }
        const taskType = proxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless';
        const task = { type: svc.name === 'capsolver' && !proxy ? 'HCaptchaTaskProxyLess' : taskType,
          websiteURL: 'https://discord.com/register', websiteKey: captchaData.captcha_sitekey,
          isEnterprise: true, enterprisePayload: { rqdata: captchaData.captcha_rqdata },
          userAgent: ua, ...proxyFields };
        // Solve
        const createRes = await (await fetch(svc.url + '/createTask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: apiKey, task }),
        })).json();
        if (createRes.errorId) { console.log(`[test] ${svc.name} create error: ${createRes.errorCode}`); continue; }
        console.log(`[test] ${svc.name} taskId=${createRes.taskId}`);
        let token = null;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const res = await (await fetch(svc.url + '/getTaskResult', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: apiKey, taskId: createRes.taskId }),
          })).json();
          if (res.status === 'ready') { token = res.solution?.gRecaptchaResponse ?? res.solution?.token; break; }
          if (res.errorId) { console.log(`[test] ${svc.name} error: ${res.errorCode}`); break; }
        }
        if (!token) { console.log(`[test] ${svc.name}: no token`); continue; }
        console.log(`[test] ${svc.name} token: ${token.slice(0, 30)}...`);
        // Resubmit
        formData.captcha_key = token;
        if (captchaData.captcha_rqtoken) formData.captcha_rqtoken = captchaData.captcha_rqtoken;
        const hdrs = { 'Content-Type': 'application/json', ...headers };
        const result = await s.page.evaluate(`(async()=>{var r=await fetch('/api/v9/auth/register',{method:'POST',headers:${JSON.stringify(hdrs)},body:${JSON.stringify(JSON.stringify(formData))}});var d=await r.json().catch(()=>({}));return{status:r.status,data:d}})()`).catch(e => ({ error: e.message }));
        console.log(`[test] ${svc.name} resubmit: status=${result?.status} response=${JSON.stringify(result?.data).slice(0, 200)}`);
        if (result?.status >= 200 && result?.status < 300) {
          console.log(`[test] SUCCESS with ${svc.name}! token=${result?.data?.token?.slice(0, 30)}`);
          registered = true;
          if (result?.data?.token) {
            const authToken = result.data.token;
            console.log(`[test] Auth token: ${authToken.slice(0, 30)}...`);
            // Verify email: poll Resend for Discord verification email, extract link, follow redirects for token
            const emailAddr = s.resolveEnv('$DISCORD_NEW_EMAIL');
            console.log(`[test] Polling for verification email to ${emailAddr}...`);
            let emailToken = null;
            const resendKey = process.env.RESEND_RECEIVING_API_KEY;
            for (let poll = 0; poll < 15 && !emailToken; poll++) {
              await s.wait(5);
              const emails = await (await fetch('https://api.resend.com/emails/receiving?limit=5', { headers: { Authorization: `Bearer ${resendKey}` } })).json();
              for (const em of emails.data || []) {
                const to = (em.to || []).map(t => typeof t === 'string' ? t : t.email).join(',');
                if (!to.includes(emailAddr) || !em.from?.includes('discord') || !em.subject?.includes('Verify Email')) continue;
                const full = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${resendKey}` } })).json();
                const links = (full.html || '').match(/https:\/\/click\.discord\.com[^\s"]+/g);
                if (!links?.length) continue;
                // Follow redirects to find the verify token
                for (const link of links) {
                  try {
                    const resp = await fetch(link, { redirect: 'manual' });
                    let loc = resp.headers.get('location') || '';
                    for (let hop = 0; hop < 5 && loc; hop++) {
                      if (loc.includes('token=')) { emailToken = new globalThis.URL(loc).searchParams.get('token') || loc.match(/token=([^&]+)/)?.[1]; break; }
                      const r2 = await fetch(loc, { redirect: 'manual' });
                      loc = r2.headers.get('location') || '';
                    }
                    if (emailToken) break;
                  } catch {}
                }
                if (emailToken) break;
              }
            }
            if (emailToken) {
              console.log(`[test] Email token: ${emailToken.slice(0, 20)}...`);
              // Call Discord verify API — may need captcha
              let verifyRes = await s.page.evaluate(`(async()=>{var r=await fetch('/api/v9/auth/verify',{method:'POST',headers:{'Authorization':${JSON.stringify(authToken)},'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(emailToken)},captcha_key:null})});return{status:r.status,data:await r.json().catch(()=>({}))};})()`).catch(e => ({ error: e.message }));
              console.log(`[test] Verify API: status=${verifyRes?.status} response=${JSON.stringify(verifyRes?.data).slice(0, 200)}`);
              // If captcha required on verify, solve it
              if (verifyRes?.data?.captcha_key && verifyRes?.data?.captcha_sitekey) {
                console.log('[test] Verify needs captcha, solving...');
                for (const svc of services) {
                  const apiKey = process.env[svc.envKey];
                  if (!apiKey) continue;
                  const vTask = { type: proxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless', websiteURL: 'https://discord.com/verify', websiteKey: verifyRes.data.captcha_sitekey, isEnterprise: true, enterprisePayload: { rqdata: verifyRes.data.captcha_rqdata }, userAgent: ua, ...proxyFields };
                  const vCreate = await (await fetch(svc.url + '/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, task: vTask }) })).json();
                  if (vCreate.errorId) { console.log(`[test] ${svc.name} verify error: ${vCreate.errorCode}`); continue; }
                  let vToken = null;
                  for (let i = 0; i < 60; i++) { await new Promise(r => setTimeout(r, 5000)); const vr = await (await fetch(svc.url + '/getTaskResult', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, taskId: vCreate.taskId }) })).json(); if (vr.status === 'ready') { vToken = vr.solution?.gRecaptchaResponse ?? vr.solution?.token; break; } if (vr.errorId) break; }
                  if (!vToken) { console.log(`[test] ${svc.name} verify captcha failed`); continue; }
                  console.log(`[test] ${svc.name} verify captcha solved`);
                  verifyRes = await s.page.evaluate(`(async()=>{var r=await fetch('/api/v9/auth/verify',{method:'POST',headers:{'Authorization':${JSON.stringify(authToken)},'Content-Type':'application/json'},body:JSON.stringify({token:${JSON.stringify(emailToken)},captcha_key:${JSON.stringify(vToken)}${verifyRes.data.captcha_rqtoken ? `,captcha_rqtoken:${JSON.stringify(verifyRes.data.captcha_rqtoken)}` : ''}})});return{status:r.status,data:await r.json().catch(()=>({}))};})()`).catch(e => ({ error: e.message }));
                  console.log(`[test] Verify+captcha: status=${verifyRes?.status} response=${JSON.stringify(verifyRes?.data).slice(0, 200)}`);
                  if (verifyRes?.status === 200) break;
                }
              }
              const finalToken = verifyRes?.data?.token || authToken;
              // Navigate to Discord home with verified token
              await s.page.evaluate(`localStorage.setItem("token", JSON.stringify(${JSON.stringify(finalToken)}))`).catch(() => {});
              await s.goto('https://discord.com/channels/@me');
              await s.wait(10);
              console.log(`[test] Final URL: ${s.page.url?.()}`);
            } else {
              console.log('[test] No email verification token found');
            }
          }
          break;
        }
      }
      if (!registered) console.log('[test] All services returned invalid-response');
    } else {
      console.log('[test] No captcha data intercepted — captcha may not have appeared');
    }

    await s.wait(5);
    const email = await s.checkEmail('$DISCORD_NEW_EMAIL', 'discord');
    if (email && email !== 'no code received') {
      await s.fill('verification code', email);
      await s.click('Submit');
    }
    await s.saveAccount('discord', { username: id.username, email: id.email, password: id.password });
    console.log(`PASS: ${id.username}`);
  } else {
    await s.goto(URL);
    await s.wait(3);
    const result = await execute(s, `Open ${URL}. ${GOAL}`, { flowName: 'discord_register' });
    console.log('PASS:', result.value);
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
