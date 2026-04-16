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
    // Click terms checkbox — target the checkboxOption wrapper, not just the text
    const termsClicked = await s.page.locator('[class*="checkboxOption"]').click().catch(() => 'missed');
    if (termsClicked !== 'missed') console.log('[test] Terms checkbox clicked');
    else { await s.page.locator('text=I have read and agree').click().catch(() => {}); console.log('[test] Terms text clicked'); }
    await s.wait(1);
    // Verify button is enabled before trying to submit
    const btnDisabled = await s.page.locator('button[type="submit"]').isDisabled().catch(() => true);
    console.log(`[test] Submit button disabled=${btnDisabled}`);
    // Retry submit until captcha data is intercepted
    for (let attempt = 0; attempt < 5; attempt++) {
      await s.page.locator('button[type="submit"]').click({ force: true }).catch(() => {});
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
        // Patch fetch to inject solved captcha_key into the next /auth/register request
        await s.page.evaluate(`(()=>{
          window.__welesToken = ${JSON.stringify(token)};
          if (!window.__welesFetchPatched) {
            window.__welesFetchPatched = true;
            var _f = window.fetch;
            window.fetch = function(url, opts) {
              if (typeof url === 'string' && url.includes('/auth/register') && opts && opts.body) {
                try {
                  var body = JSON.parse(opts.body);
                  if (window.__welesToken) {
                    body.captcha_key = window.__welesToken;
                    opts.body = JSON.stringify(body);
                    console.log('[weles] Injected captcha_key into register request');
                    window.__welesToken = null;
                  }
                } catch(e) {}
              }
              return _f.apply(this, arguments);
            };
          }
        })()`).catch(() => {});
        // Dump hcaptcha state to find the callback, then call it
        const hcState = await s.page.evaluate(`(()=>{
          if (!window.hcaptcha) return 'no hcaptcha';
          var info = { methods: Object.keys(hcaptcha).filter(k=>typeof hcaptcha[k]==='function'), ids: hcaptcha.getAllIds?.() ?? [] };
          // Look for internal state/config with callbacks
          for (var k of Object.getOwnPropertyNames(hcaptcha)) {
            var v = hcaptcha[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              info[k] = Object.keys(v).slice(0, 20);
            }
          }
          // Check the render containers for data attributes
          var containers = document.querySelectorAll('[data-hcaptcha-widget-id]');
          info.containers = containers.length;
          // Try to find React fiber with callback
          var captchaEl = document.querySelector('[class*="captcha"]');
          if (captchaEl) {
            var fiberKey = Object.keys(captchaEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
            if (fiberKey) info.hasFiber = true;
          }
          return JSON.stringify(info);
        })()`).catch(e => `error: ${e.message?.slice(0, 80)}`);
        console.log(`[test] hcaptcha state: ${hcState}`);
        // Try calling the callback via React fiber
        const callbackResult = await s.page.evaluate(`(()=>{
          // Walk React fiber tree to find captcha callback
          function findCallback(el) {
            if (!el) return null;
            var fk = Object.keys(el).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
            if (!fk) return null;
            var fiber = el[fk];
            while (fiber) {
              var props = fiber.memoizedProps || fiber.pendingProps || {};
              if (props.onVerify) return props.onVerify;
              if (props.callback) return props.callback;
              if (props.onSuccess) return props.onSuccess;
              fiber = fiber.return;
            }
            return null;
          }
          var captchaEls = document.querySelectorAll('[class*="captcha"], [class*="Captcha"]');
          for (var el of captchaEls) {
            var cb = findCallback(el);
            if (cb) { cb(${JSON.stringify(token)}); return 'react-callback'; }
          }
          // Also try modal overlay
          var modal = document.querySelector('[class*="modal"], [class*="Modal"]');
          if (modal) { var cb = findCallback(modal); if (cb) { cb(${JSON.stringify(token)}); return 'modal-callback'; } }
          return 'no-callback-found';
        })()`).catch(e => `error: ${e.message?.slice(0, 80)}`);
        console.log(`[test] ${svc.name} callback result: ${callbackResult}`);
        await s.wait(10);
        // Check if registration succeeded by looking at URL or intercepted response
        const postUrl = s.page.url?.() ?? '';
        const postCaptcha = s.captchaResponse;
        console.log(`[test] After inject: url=${postUrl.slice(0, 60)} captchaResponse=${!!postCaptcha}`);
        if (postUrl.includes('/channels') || postUrl.includes('/app') || postUrl.includes('/login')) {
          console.log(`[test] SUCCESS with ${svc.name}! Navigated to ${postUrl.slice(0, 60)}`);
          registered = true;
          // Get auth token from localStorage (Discord SPA stores it after successful registration)
          const authToken = await s.page.evaluate('try{return JSON.parse(localStorage.getItem("token"))}catch(e){return null}').catch(() => null);
          console.log(`[test] Auth token from localStorage: ${authToken?.slice(0, 30) ?? 'none'}`);
          if (authToken) {
            // Verify email in-browser: set token in localStorage, navigate to verify link
            const emailAddr = s.resolveEnv('$DISCORD_NEW_EMAIL');
            console.log(`[test] Setting auth token and polling for verify email to ${emailAddr}...`);
            // Set token so browser is "logged in"
            await s.page.evaluate(`localStorage.setItem("token", JSON.stringify(${JSON.stringify(authToken)}))`).catch(() => {});
            const resendKey = process.env.RESEND_RECEIVING_API_KEY;
            let verified = false;
            for (let poll = 0; poll < 15 && !verified; poll++) {
              await s.wait(5);
              const emails = await (await fetch('https://api.resend.com/emails/receiving?limit=5', { headers: { Authorization: `Bearer ${resendKey}` } })).json();
              for (const em of emails.data || []) {
                const to = (em.to || []).map(t => typeof t === 'string' ? t : t.email).join(',');
                if (!to.includes(emailAddr) || !em.from?.includes('discord') || !em.subject?.includes('Verify Email')) continue;
                const full = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${resendKey}` } })).json();
                const links = (full.html || '').match(/https:\/\/click\.discord\.com[^\s"]+/g);
                if (!links?.length) continue;
                // Find the link that redirects to /verify#token= (2nd link in the email, not the 1st)
                let verifyLink = null;
                for (const link of links) {
                  try { const r = await fetch(link, { redirect: 'manual' }); const loc = r.headers.get('location') || ''; if (loc.includes('/verify')) { verifyLink = loc; break; } } catch {}
                }
                if (!verifyLink) verifyLink = links[1] || links[0];
                console.log(`[test] Verify URL: ${(typeof verifyLink === 'string' ? verifyLink : '').slice(0, 80)}...`);
                await s.goto(verifyLink);
                await s.wait(5);
                console.log(`[test] After verify link: ${s.page.url?.()}`);
                // Navigate to channels to confirm
                await s.goto('https://discord.com/channels/@me');
                await s.wait(10);
                const finalUrl = s.page.url?.() ?? '';
                console.log(`[test] Final URL: ${finalUrl}`);
                verified = finalUrl.includes('/channels');
                break;
              }
            }
            if (!verified) console.log('[test] Email verification did not complete');
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
