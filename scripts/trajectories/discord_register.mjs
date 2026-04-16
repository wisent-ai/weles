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
    await s.wait(3);
    await s.fill('Email', '$DISCORD_NEW_EMAIL');
    await s.fill('Display Name', '$DISCORD_NEW_USERNAME');
    await s.fill('Username', '$DISCORD_NEW_USERNAME');
    await s.fill('Password', '$DISCORD_NEW_PASSWORD');
    await s.select('month', '$DISCORD_NEW_BIRTHMONTH');
    await s.select('day', '$DISCORD_NEW_BIRTHDAY');
    await s.select('year', '$DISCORD_NEW_BIRTHYEAR');
    await s.wait(1);
    // Terms checkbox — need locator click because humanClick misses small targets
    const terms = s.page.locator('text=I have read and agree');
    if (await terms.isVisible().catch(() => false)) await terms.click();
    await s.wait(1);
    await s.page.locator('button[type="submit"]').click();
    await s.wait(5);

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
          let ip = u.hostname;
          try { const { lookup } = await import('node:dns'); ip = await new Promise((res, rej) => lookup(u.hostname, (e, a) => e ? rej(e) : res(a))); } catch {}
          Object.assign(proxyFields, { proxyType: 'http', proxyAddress: ip, proxyPort: parseInt(u.port, 10), proxyLogin: proxy.username, proxyPassword: proxy.password });
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
        console.log(`[test] ${svc.name} resubmit: status=${result?.status} captcha_key=${result?.data?.captcha_key?.[0] ?? 'none'}`);
        if (result?.status >= 200 && result?.status < 300) {
          console.log(`[test] SUCCESS with ${svc.name}!`);
          registered = true;
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
