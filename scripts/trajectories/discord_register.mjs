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
    // Fill via JS value setter + React events (more reliable than el.fill for Discord SPA)
    const fillField = async (name, val) => {
      const resolved = s.resolveEnv(val);
      const result = await s.page.evaluate(`(({ name, val }) => {
        const el = document.querySelector('input[name="' + name + '"]');
        if (!el) return { ok: false, reason: 'not-found' };
        el.focus();
        const originalType = el.type;
        if (originalType === 'password') el.type = 'text';
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(el, val);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        if (originalType === 'password') el.type = originalType;
        return { ok: true, len: val.length };
      })(${JSON.stringify({ name, val: resolved })})`);
      console.log(`[test] fill ${name}: ${JSON.stringify(result)}`);
      return result;
    };
    // Wait for form to fully render (comboboxes take longer than text inputs)
    for (let i = 0; i < 15; i++) {
      const ready = await s.page.evaluate('document.querySelectorAll("[role=combobox]").length >= 3').catch(() => false);
      if (ready) { console.log(`[test] Form comboboxes ready after ${i + 1}s`); break; }
      await s.wait(1);
    }
    // DOB selects first (with retry for each)
    const selectWithRetry = async (target, value) => {
      let result = await s.select(target, value);
      if (!result || result.includes('no-select-found')) {
        await s.page.keyboard.press('Escape').catch(() => {});
        await s.wait(1);
        result = await s.select(target, value);
      }
      return result;
    };
    await selectWithRetry('month', '$DISCORD_NEW_BIRTHMONTH');
    await selectWithRetry('day', '$DISCORD_NEW_BIRTHDAY');
    await selectWithRetry('year', '$DISCORD_NEW_BIRTHYEAR');
    await s.wait(1);
    // Fill text fields AFTER DOB (DOB selection resets React-controlled inputs)
    await fillField('email', '$DISCORD_NEW_EMAIL');
    await fillField('global_name', '$DISCORD_NEW_USERNAME');
    await fillField('username', '$DISCORD_NEW_USERNAME');
    await fillField('password', '$DISCORD_NEW_PASSWORD');
    await s.wait(1);
    // Click terms checkbox — target the checkboxOption wrapper, not just the text
    const termsClicked = await s.page.locator('[class*="checkboxOption"]').click().catch(() => 'missed');
    if (termsClicked !== 'missed') console.log('[test] Terms checkbox clicked');
    else { await s.page.locator('text=I have read and agree').click().catch(() => {}); console.log('[test] Terms text clicked'); }
    await s.wait(1);
    // Check form state before submit
    const formState = await s.page.evaluate(`(() => {
      var inputs = Array.from(document.querySelectorAll('input'));
      var vals = inputs.map(i => ({ name: i.name || i.type || i.placeholder, value: i.value?.slice(0, 20), type: i.type }));
      var form = document.querySelector('form');
      var btn = document.querySelector('button[type="submit"]');
      return { inputs: vals, hasForm: !!form, formAction: form?.action, btnDisabled: btn?.disabled, btnText: btn?.textContent?.trim() };
    })()`).catch(() => ({}));
    console.log(`[test] Form state: ${JSON.stringify(formState)}`);
    const btnDisabled = formState.btnDisabled ?? true;
    if (btnDisabled) { console.log('FAIL: submit button disabled — form validation failed'); process.exit(1); }
    // Retry submit until captcha data is intercepted
    for (let attempt = 0; attempt < 8; attempt++) {
      // Try multiple click strategies
      await s.page.locator('button[type="submit"]').click().catch(() => {});
      await s.wait(2);
      if (s.captchaResponse) { console.log('[test] Form submitted (captcha intercepted via locator click)'); break; }
      await s.page.evaluate('document.querySelector("button[type=submit]")?.click()').catch(() => {});
      await s.wait(2);
      if (s.captchaResponse) { console.log('[test] Form submitted (captcha intercepted via JS click)'); break; }
      await s.page.evaluate('document.querySelector("form")?.requestSubmit()').catch(() => {});
      await s.wait(2);
      if (s.captchaResponse) { console.log('[test] Form submitted via requestSubmit'); break; }
      // Also try clicking "Create Account" text directly
      await s.click('Create Account').catch(() => {});
      await s.wait(2);
      if (s.captchaResponse) { console.log('[test] Form submitted via s.click("Create Account")'); break; }
      // Check for hCaptcha iframe or error messages
      const pageState = await s.page.evaluate(`(() => {
        var hc = document.querySelector('iframe[src*="hcaptcha"]');
        var errs = Array.from(document.querySelectorAll('[class*="error"], [class*="Error"]')).map(e => e.textContent?.trim()).filter(Boolean).slice(0, 3);
        var btnText = document.querySelector('button[type="submit"]')?.textContent;
        return { hcaptcha: !!hc, errors: errs, btnText, url: location.href };
      })()`).catch(() => ({}));
      console.log(`[test] Submit attempt ${attempt + 1} — no captcha response. state=${JSON.stringify(pageState)}`);
    }
    await s.wait(3);

    // Solve captcha and submit via direct API (same approach as discord_login.mjs)
    const captchaData = s.captchaResponse;
    const formData = s.captchaFormData;
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
        let currentRqdata = captchaData.captcha_rqdata;
        let currentRqtoken = captchaData.captcha_rqtoken;

        // Build proxy fields for captcha service
        // Local proxies use CAPTCHA_PROXY_URL (public tunnel) if available, otherwise proxyless
        const proxyFields = {};
        const isLocalProxy = proxy && (proxy.server.includes('127.0.0.1') || proxy.server.includes('localhost'));
        const captchaProxyUrl = process.env.CAPTCHA_PROXY_URL;
        let useProxy = false;
        if (isLocalProxy && captchaProxyUrl) {
          const cu = new globalThis.URL(captchaProxyUrl);
          Object.assign(proxyFields, { proxyType: 'http', proxyAddress: cu.hostname, proxyPort: parseInt(cu.port, 10), proxyLogin: cu.username ? decodeURIComponent(cu.username) : undefined, proxyPassword: cu.password ? decodeURIComponent(cu.password) : undefined });
          console.log(`[test] Captcha via tunnel proxy: ${cu.hostname}:${cu.port}`);
          useProxy = true;
        } else if (proxy && !isLocalProxy) {
          const u = new globalThis.URL(proxy.server);
          let gwIp = u.hostname;
          try { const dns = await import('node:dns'); gwIp = await new Promise((res, rej) => dns.lookup(u.hostname, (e, a) => e ? rej(e) : res(a))); } catch {}
          Object.assign(proxyFields, { proxyType: 'http', proxyAddress: gwIp, proxyPort: parseInt(u.port, 10), proxyLogin: proxy.username, proxyPassword: proxy.password });
          console.log(`[test] Proxy for captcha: ${gwIp}:${u.port} user=${proxy.username?.slice(0, 20)}`);
          useProxy = true;
        } else if (isLocalProxy) {
          console.log(`[test] Local proxy, no CAPTCHA_PROXY_URL — solving proxyless`);
        }

        for (let attempt = 0; attempt < 3; attempt++) {
          const taskType = useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless';
          const task = { type: svc.name === 'capsolver' ? (useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyLess') : taskType,
            websiteURL: 'https://discord.com/register', websiteKey: captchaData.captcha_sitekey,
            isEnterprise: true, enterprisePayload: { rqdata: currentRqdata },
            userAgent: ua, ...proxyFields };
          const createRes = await (await fetch(svc.url + '/createTask', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: apiKey, task }),
          })).json();
          if (createRes.errorId) { console.log(`[test] ${svc.name} error: ${createRes.errorCode}`); break; }
          console.log(`[test] ${svc.name} attempt ${attempt + 1} solving...`);
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
          if (!token) { console.log(`[test] ${svc.name}: no token`); break; }
          console.log(`[test] ${svc.name} token: ${token.slice(0, 30)}...`);

          // Submit directly via API (same pattern as discord_login.mjs)
          formData.captcha_key = token;
          if (currentRqtoken) formData.captcha_rqtoken = currentRqtoken;
          const hdrs = JSON.stringify({ 'Content-Type': 'application/json', ...s.captchaHeaders });
          const result = await s.page.evaluate(`(async()=>{var r=await fetch('/api/v9/auth/register',{method:'POST',headers:${hdrs},body:${JSON.stringify(JSON.stringify(formData))}});return{status:r.status,data:await r.json().catch(()=>({}))};})()`).catch(e => ({ error: e.message }));
          console.log(`[test] ${svc.name} attempt ${attempt + 1}: status=${result?.status} response=${JSON.stringify(result?.data).slice(0, 200)}`);

          if ((result?.status === 200 || result?.status === 201) && result?.data?.token) {
            console.log(`[test] SUCCESS — auth token received`);
            const authToken = result.data.token;
            await s.page.evaluate(`localStorage.setItem("token", JSON.stringify(${JSON.stringify(authToken)}))`).catch(() => {});
            await s.goto('https://discord.com/channels/@me');
            await s.wait(5);
            console.log(`[test] Navigated to: ${s.page.url?.()}`);
            registered = true;
            await s.saveAccount('discord', { username: id.username, email: id.email, password: id.password });
            console.log(`PASS: ${id.username}`);

            // Verify email: find the verify link and open it in the browser
            const emailAddr = s.resolveEnv('$DISCORD_NEW_EMAIL');
            console.log(`[test] Polling for verify email to ${emailAddr}...`);
            const resendKey = process.env.RESEND_RECEIVING_API_KEY;
            let verified = false;
            for (let poll = 0; poll < 20 && !verified; poll++) {
              await s.wait(5);
              const emails = await (await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${resendKey}` } })).json();
              for (const em of emails.data || []) {
                const to = (em.to || []).map(t => typeof t === 'string' ? t : t.email).join(',');
                if (!to.includes(emailAddr) || !em.from?.includes('discord') || !em.subject?.includes('Verify')) continue;
                const full = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${resendKey}` } })).json();
                const links = (full.html || '').match(/https:\/\/click\.discord\.com[^\s"]+/g);
                if (!links?.length) continue;
                // Find the verify link (resolves to /verify#token=...)
                for (const link of links) {
                  try {
                    const r = await fetch(link, { redirect: 'manual' });
                    const loc = r.headers.get('location') || '';
                    if (loc.includes('/verify')) {
                      console.log(`[test] Opening verify link in browser...`);
                      await s.goto(loc);
                      await s.wait(5);
                      console.log(`[test] After verify: ${s.page.url?.()}`);
                      verified = true;
                      break;
                    }
                  } catch {}
                }
                break;
              }
            }
            if (!verified) console.log('[test] Email verification did not complete');
            else console.log('[test] Email verified');
            break;
          }
          // Discord returned new captcha data — retry with updated rqdata
          if (result?.data?.captcha_rqdata) {
            currentRqdata = result.data.captcha_rqdata;
            currentRqtoken = result.data.captcha_rqtoken;
            console.log('[test] Updated captcha data, retrying...');
            continue;
          }
          break;
        }
        if (registered) break;
      }
      if (!registered) { console.log('FAIL: all captcha attempts exhausted'); process.exit(1); }
    } else {
      console.log('FAIL: no captcha data intercepted');
      process.exit(1);
    }
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
