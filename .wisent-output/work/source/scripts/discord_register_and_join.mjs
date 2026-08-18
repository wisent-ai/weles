import { WSession } from '../dist/session/wsession.js';
import { readScopedSecret } from './_shared/scoped-secrets.mjs';

const SERVERS_TO_JOIN = [
  'https://discord.gg/python',      // Python community
  'https://discord.gg/reactjs',     // React.js 
  'https://discord.gg/typescript',  // TypeScript
];

const s = await WSession.start({ label: 'discord_join', proxy: process.env.PROXY_URL || 'residential' });
try {
  // Step 1: Register
  const id = await s.generateIdentity('discord');
  await s.goto('https://discord.com/register');
  for (let i = 0; i < 30; i++) {
    const mounted = await s.page.evaluate('document.querySelector("#app-mount")?.children?.length > 0').catch(() => false);
    if (mounted) { console.log(`[join] SPA mounted after ${i + 1}s`); break; }
    await s.wait(1);
  }

  // Fill form via JS setter
  const fillField = async (name, val) => {
    const resolved = s.resolveEnv(val);
    return s.page.evaluate(`(({ name, val }) => {
      const el = document.querySelector('input[name="' + name + '"]');
      if (!el) return { ok: false };
      el.focus();
      const ot = el.type; if (ot === 'password') el.type = 'text';
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, val);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      if (ot === 'password') el.type = ot;
      return { ok: true, len: val.length };
    })(${JSON.stringify({ name, val: resolved })})`);
  };
  await fillField('email', '$DISCORD_NEW_EMAIL');
  await fillField('global_name', '$DISCORD_NEW_USERNAME');
  await fillField('username', '$DISCORD_NEW_USERNAME');
  await fillField('password', '$DISCORD_NEW_PASSWORD');
  console.log(`[join] Form filled: ${id.username} / ${id.email}`);

  await s.select('month', '$DISCORD_NEW_BIRTHMONTH');
  await s.select('day', '$DISCORD_NEW_BIRTHDAY');
  await s.select('year', '$DISCORD_NEW_BIRTHYEAR');
  await s.wait(1);

  // Terms checkbox
  await s.page.locator('[class*="checkboxOption"]').click().catch(() =>
    s.page.locator('text=I have read and agree').click().catch(() => {})
  );
  await s.wait(1);

  // Submit
  await s.page.locator('button[type="submit"]').click().catch(() => {});
  await s.wait(3);
  if (!s.captchaResponse) {
    await s.page.evaluate('document.querySelector("form")?.requestSubmit()').catch(() => {});
    await s.wait(3);
  }
  if (!s.captchaResponse) { console.log('FAIL: no captcha'); process.exit(1); }

  // Solve captcha
  const captchaData = s.captchaResponse;
  const formData = s.captchaFormData;
  const ua = await s.page.evaluate('navigator.userAgent').catch(() => '');
  const proxy = s.proxyConfig;
  const apiKey = readScopedSecret('antiCaptcha', 'api_key');
  const proxyFields = {};
  if (proxy) {
    const u = new URL(proxy.server);
    Object.assign(proxyFields, { proxyType: 'http', proxyAddress: u.hostname, proxyPort: parseInt(u.port, 10), proxyLogin: proxy.username, proxyPassword: proxy.password });
  }
  const task = { type: proxy ? 'HCaptchaTask' : 'HCaptchaTaskProxyless',
    websiteURL: 'https://discord.com/register', websiteKey: captchaData.captcha_sitekey,
    isEnterprise: true, enterprisePayload: { rqdata: captchaData.captcha_rqdata },
    userAgent: ua, ...proxyFields };
  console.log('[join] Solving captcha...');
  const cr = await (await fetch('https://api.anti-captcha.com/createTask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, task }),
  })).json();
  if (cr.errorId) { console.log(`FAIL: captcha create: ${cr.errorCode}`); process.exit(1); }
  let token = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
    const res = await (await fetch('https://api.anti-captcha.com/getTaskResult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, taskId: cr.taskId }),
    })).json();
    if (res.status === 'ready') { token = res.solution?.gRecaptchaResponse ?? res.solution?.token; break; }
    if (res.errorId) break;
  }
  if (!token) { console.log('FAIL: captcha solve'); process.exit(1); }
  console.log('[join] Captcha solved, registering...');

  // Register via API
  formData.captcha_key = token;
  const hdrs = JSON.stringify({ 'Content-Type': 'application/json', ...s.captchaHeaders });
  const result = await s.page.evaluate(`(async()=>{var r=await fetch('/api/v9/auth/register',{method:'POST',headers:${hdrs},body:${JSON.stringify(JSON.stringify(formData))}});return{status:r.status,data:await r.json().catch(()=>({}))};})()`).catch(e => ({ error: e.message }));
  if (!(result?.status === 200 || result?.status === 201) || !result?.data?.token) {
    console.log(`FAIL: register status=${result?.status} ${JSON.stringify(result?.data).slice(0, 200)}`);
    process.exit(1);
  }
  const authToken = result.data.token;
  console.log(`[join] Registered: ${id.username} (token=${authToken.slice(0, 30)}...)`);

  // Step 2: Verify email
  const resendKey = readScopedSecret('resendReceiving', 'api_key');
  let verified = false;
  for (let poll = 0; poll < 20 && !verified; poll++) {
    await s.wait(5);
    const emails = await (await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${resendKey}` } })).json();
    for (const em of emails.data || []) {
      const to = (em.to || []).map(t => typeof t === 'string' ? t : t.email).join(',');
      if (!to.includes(id.email) || !em.subject?.includes('Verify')) continue;
      const full = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${resendKey}` } })).json();
      // Extract the verify token from the email HTML (the API link)
      const tokenMatch = (full.html || '').match(/verify#token=([^"&\s]+)/);
      if (tokenMatch) {
        // Verify via Discord API directly (no browser needed)
        const verifyRes = await fetch('https://discord.com/api/v9/auth/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: authToken },
          body: JSON.stringify({ token: tokenMatch[1] }),
        });
        console.log(`[join] Email verify API: ${verifyRes.status}`);
        if (verifyRes.ok) { verified = true; const vd = await verifyRes.json(); if (vd.token) { /* update token if refreshed */ } }
        break;
      }
      // Fallback: use click.discord.com link
      const links = (full.html || '').match(/https:\/\/click\.discord\.com[^\s"]+/g);
      if (links?.length) {
        for (const link of links) {
          try { const r = await fetch(link, { redirect: 'manual' }); const loc = r.headers.get('location') || ''; if (loc.includes('/verify')) {
            // Call verify API
            const vToken = loc.match(/token=([^&]+)/)?.[1];
            if (vToken) {
              const vr = await fetch('https://discord.com/api/v9/auth/verify', {
                method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: authToken },
                body: JSON.stringify({ token: vToken }),
              });
              console.log(`[join] Email verify via link: ${vr.status}`);
              if (vr.ok) verified = true;
            }
            break;
          }} catch {}
        }
        if (verified) break;
      }
    }
  }
  console.log(`[join] Email verified: ${verified}`);

  // Step 3: Save account
  await s.saveAccount('discord', { username: id.username, email: id.email, password: id.password });
  console.log(`PASS: ${id.username}`);

  // Step 4: Join Discord servers via API
  for (const invite of SERVERS_TO_JOIN) {
    const code = invite.split('/').pop();
    const joinRes = await fetch(`https://discord.com/api/v9/invites/${code}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authToken },
    });
    const joinData = await joinRes.json().catch(() => ({}));
    console.log(`[join] Server ${code}: ${joinRes.status} — ${joinData.guild?.name ?? joinData.message ?? 'unknown'}`);
    await s.wait(2);
  }

  // Step 5: Navigate to channels in browser and take screenshots
  await s.page.evaluate(`localStorage.setItem("token", JSON.stringify(${JSON.stringify(authToken)}))`).catch(() => {});
  await s.goto('https://discord.com/channels/@me');
  await s.wait(10);
  console.log(`[join] Browser URL: ${s.page.url?.()}`);
  await s.screenshot('joined_servers');
  console.log('[join] Screenshot saved');

} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
