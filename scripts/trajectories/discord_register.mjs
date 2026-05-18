import { WSession } from '../../dist/session/wsession.js';
import { humanClickLocator } from '../../dist/human/mouse.js';
import { autoBindCharacter } from './lib/character-bind.mjs';
import { markBurnedIp } from '../../dist/proxy/burned.js';

const URL = 'https://discord.com/register';

// Reroll-until-clean (the proven linkedin_register pattern). A single
// random Oxylabs Residential sticky is frequently hCaptcha-flagged for
// Discord register — EVERY solver token comes back 400 captcha-required
// regardless of solver. That is an IP-reputation signal, not a solver
// problem: markBurnedIp the exit (/32+/24+/19+ASN) and re-create the
// session; resolveProxy skips burned IPs so the next sticky is a fresh
// exit. targetHost lets resolveProxy map the "residential oxylabs us"
// filter to a provider row + Discord country policy.
const MAX_REROLL = parseInt(process.env.DISCORD_MAX_REROLL || '6', 10);
let registeredOk = false;
for (let reroll = 0; reroll < MAX_REROLL && !registeredOk; reroll++) {
const s = await WSession.start({ label: 'discord_register', proxy: process.env.PROXY_URL || 'residential', targetHost: 'discord.com', browser: 'chromium' });
const exitIp = s.proxyConfig?.exit_ip || (s.proxyConfig?.server ? new globalThis.URL(s.proxyConfig.server).hostname : null);
console.log(`[reroll ${reroll + 1}/${MAX_REROLL}] exit=${exitIp ?? 'unknown'}`);
try {
  {
    // Single deterministic path: hCaptcha solve via service + direct
    // /api/v9/auth/register POST. No agent loop.
    const id = await s.generateIdentity('discord');
    await s.goto(URL);
    // Wait for Discord SPA to mount (Cloudflare may delay JS execution)
    for (let i = 0; i < 30; i++) {
      const mounted = await s.page.evaluate('document.querySelector("#app-mount")?.children?.length > 0').catch(() => false);
      if (mounted) { console.log(`[test] SPA mounted after ${i + 1}s`); break; }
      await s.wait(1);
    }
    // Humanized fill — replaces descriptor-set + dispatch('input') which
    // bypassed every keystroke (anti-bot signal). humanFill clicks, clears,
    // then types one char at a time with trace-derived timing.
    const { humanFill } = await import('../../dist/human/keyboard.js');
    const fillField = async (name, val) => {
      const resolved = s.resolveEnv(val);
      const loc = s.page.locator(`input[name="${name}"]`).first();
      if (!(await loc.count())) { const r = { ok: false, reason: 'not-found' }; console.log(`[test] fill ${name}: ${JSON.stringify(r)}`); return r; }
      await humanFill(s.page, loc, resolved);
      const r = { ok: true, len: resolved.length };
      console.log(`[test] fill ${name}: ${JSON.stringify(r)}`);
      return r;
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
    const termsClicked = await humanClickLocator(s.page, s.page.locator('[class*="checkboxOption"]').first()).then(() => 'ok').catch(() => 'missed');
    if (termsClicked !== 'missed') console.log('[test] Terms checkbox clicked');
    else { await humanClickLocator(s.page, s.page.locator('text=I have read and agree').first()).catch(() => {}); console.log('[test] Terms text clicked'); }
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
      await humanClickLocator(s.page, s.page.locator('button[type="submit"]').first()).catch(() => {});
      await s.wait(2);
      if (s.captchaResponse) { console.log('[test] Form submitted (captcha intercepted via locator click)'); break; }
      // Second strategy: same selector but skip Playwright's actionability
      // check (force). Still routes through CDP so it's a trusted click,
      // just with the should-be-visible/should-be-enabled checks bypassed.
      await humanClickLocator(s.page, s.page.locator('button[type="submit"]').first()).catch(() => {});
      await s.wait(2);
      if (s.captchaResponse) { console.log('[test] Form submitted (captcha intercepted via force locator click)'); break; }
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
          const isCs = svc.name === 'capsolver';
          // CapSolver requires HCaptchaEnterpriseTaskProxyLess for enterprise sites;
          // anticaptcha uses HCaptchaTaskProxyless + isEnterprise:true.
          const taskType = isCs
            ? (useProxy ? 'HCaptchaEnterpriseTask' : 'HCaptchaEnterpriseTaskProxyLess')
            : (useProxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless');
          const task = { type: taskType,
            websiteURL: 'https://discord.com/register', websiteKey: captchaData.captcha_sitekey,
            enterprisePayload: { rqdata: currentRqdata },
            userAgent: ua, ...proxyFields, ...(isCs ? {} : { isEnterprise: true }) };
          const createRes = await (await fetch(svc.url + '/createTask', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ clientKey: apiKey, task }),
          })).json();
          if (createRes.errorId) { console.log(`[test] ${svc.name} error: ${createRes.errorCode}`); break; }
          console.log(`[test] ${svc.name} attempt ${attempt + 1} solving...`);
          let token = null;
          for (let i = 0; i < 60; i++) {
            await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
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
            await autoBindCharacter(id.username, 'discord').then(r => console.log(`[bind] ${JSON.stringify(r)}`)).catch((e) => console.log(`[bind] err: ${e.message?.slice(0, 80)}`));
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
      if (registered) {
        registeredOk = true;
      } else if (exitIp) {
        await markBurnedIp(exitIp, 'captcha_challenge', 'discord');
        console.log(`[reroll] exit ${exitIp} burned (captcha_challenge: all solver tokens rejected) — rerolling to a fresh sticky`);
      } else {
        console.log('FAIL: all captcha attempts exhausted, no exit IP to burn');
      }
    } else {
      console.log('[reroll] no captcha data intercepted — rerolling');
      if (exitIp) await markBurnedIp(exitIp, 'action_failed', 'discord');
    }
  }
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  if (exitIp) { try { await markBurnedIp(exitIp, 'action_failed', 'discord'); } catch {} }
} finally {
  await s.close();
}
}
if (!registeredOk) { console.log('FAIL: exhausted rerolls without registration'); process.exit(1); }
process.exit(0);
