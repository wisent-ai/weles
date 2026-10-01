import { pageCondition, pageSettled } from '../_shared/page/settled.mjs';
import { solverTaskResult } from '../_shared/captcha/solver_task.mjs';
import { getSocialAccount } from '../../../dist/utils/credentials.js';
import { resolveAccountSession } from '../../../dist/account/session.js';
import { WSession } from '../../../dist/session/wsession.js';
import { persistFreshCookieJar } from '../_shared/auth/cookie-freshness.mjs';
import { runRecordingsDir } from '../../../dist/session/run-recordings.js';
import { getReceived, listReceived } from '../../_shared/resend-receiving.mjs';

const URL = 'https://discord.com/login';

const acct = await getSocialAccount('discord');
if (!acct) { console.log('FAIL: no active discord account in Skarbiec'); process.exitCode = 1; }
if (!acct.metadata.password) { console.log(`FAIL: account ${acct.username} has no password`); process.exitCode = 1; }
process.env.SVC_EMAIL = acct.metadata.email ?? acct.username;
process.env.SVC_PASSWORD = acct.metadata.password;
const accountSession = await resolveAccountSession(acct);
const proxyUrl = process.env.PROXY_URL || accountSession.proxyUrl || 'residential';
if (process.env.PROXY_URL) {
  console.log(`[trajectory] PROXY_URL override: "${proxyUrl}"`);
} else {
  console.log(`[trajectory] Using persisted account proxy pin`);
}
console.log(`[trajectory] Using account: ${acct.username} (${process.env.SVC_EMAIL})`);

// targetHost lets resolveProxy map a filter string ("residential
// oxylabs us") to the right provider row + Discord country policy.
// Without it, filter-form PROXY_URL throws proxy_unavailable.
const s = await WSession.start({ label: 'discord_login', proxy: proxyUrl, persona: accountSession.persona, targetHost: 'discord.com' });

async function captureCookies() {
  if (!acct.id) return;
  try {
    const cookies = await s.ctx.cookies();
    await persistFreshCookieJar(acct, cookies, { currentProxyUrl: proxyUrl });
  } catch (e) { console.log('[cookie-capture] err:', e.message); }
}

try {
  // Visit register page first to pass Cloudflare challenge and set cf_clearance cookie
  await s.goto('https://discord.com/register');
  await pageSettled(s.page);
  await s.goto(URL);
  await pageCondition(s.page, () => document.querySelector('#app-mount')?.children?.length > 0);
  console.log('[login] SPA mounted');
  // SPA mount != form ready
  await pageCondition(s.page, () => document.querySelectorAll('input').length > 0);
  const inputNames = await s.page.evaluate(`Array.from(document.querySelectorAll('input')).map(i=>({name:i.name,type:i.type,ph:i.placeholder,aria:i.getAttribute('aria-label')}))`).catch(() => []);
  console.log(`[login] Inputs: ${JSON.stringify(inputNames)}`);
  // Humanized fill — descriptor-set + dispatch('input') previously bypassed
  // every keystroke; route through humanFill (real click + ControlOrMeta+A
  // + humanType). Discord's React inputs work fine with keystrokes; the old
  // comment about Playwright el.fill failing was specific to the .fill()
  // synchronous-set path, not real keyboard events.
  const { humanFill } = await import('../../../dist/human/keyboard.js');
  const fillField = async (selector, val) => {
    const loc = s.page.locator(selector).first();
    if (!(await loc.count())) return { ok: false, reason: 'not-found', sel: selector };
    await humanFill(s.page, loc, val);
    return { ok: true, len: val.length };
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
  await pageSettled(s.page);
  let deactivateAccount = async () => {};
  try { ({ deactivateAccount } = await import('../../../dist/account/state.js')); } catch (e) { console.log(`[login] state.js import failed: ${e.message}`); }
  const bail = () => { try { if (s.authBlocked) { Promise.resolve(deactivateAccount(acct.id, acct.metadata, s.authBlocked)).then(() => { console.log(`FAIL: ${acct.username} ${s.authBlocked} (deactivated)`); process.exitCode = 1; }).catch(() => process.exit(1)); return true; } if ((s.page?.url?.() ?? '').includes('/channels')) { console.log(`PASS: direct login — ${s.page.url()}`); captureCookies().then(() => process.exit(0)).catch(() => process.exit(0)); return true; } } catch (e) { console.log(`[login] bail err: ${e.message}`); } return false; };
  // locator.click on Discord's submit hangs the full default timeout — click registers but its navigation promise never resolves. Skip locator.click; form.requestSubmit fires /api/v9/auth/login directly and populates captchaFormData on the response, which is what every downstream branch needs.
  await s.page.evaluate('document.querySelector("form")?.requestSubmit()');
  await pageSettled(s.page);
  bail();
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
    console.log(`[login] Proxy for captcha: ${gwIp ?? 'none'}:${u?.port ?? '-'} user=${proxy?.username?.slice(0, 30) ?? '-'}`);
    const services = [
      { name: 'anticaptcha', url: 'https://api.anti-captcha.com', envKey: 'ANTICAPTCHA_API_KEY' },
      { name: 'capsolver', url: 'https://api.capsolver.com', envKey: 'CAPSOLVER_API_KEY' },
    ];
    const svc = services.find((candidate) => process.env[candidate.envKey]);
    if (!svc) throw new Error('discord_login: no captcha solver key is configured (ANTICAPTCHA_API_KEY or CAPSOLVER_API_KEY)');
    const apiKey = process.env[svc.envKey];
    console.log(`[login] formData: login=${formData.login} pass=${formData.password ? '***(' + formData.password.length + ')' : 'EMPTY'}`);
    const isCs = svc.name === 'capsolver';
    const taskType = isCs ? (u ? 'HCaptchaEnterpriseTask' : 'HCaptchaEnterpriseTaskProxyLess') : (u ? 'HCaptchaTask' : 'HCaptchaTaskProxyless');
    const task = { type: taskType, websiteURL: 'https://discord.com/login', websiteKey: captchaData.captcha_sitekey, enterprisePayload: { rqdata: captchaData.captcha_rqdata }, userAgent: ua, ...proxyFields, ...(isCs ? {} : { isEnterprise: true }) };
    const cr = await (await fetch(svc.url + '/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, task }) })).json();
    if (cr.errorId) throw new Error(`discord_login: ${svc.name} createTask refused: ${cr.errorCode}`);
    console.log(`[login] ${svc.name} task ${cr.taskId} created`);
    formData.captcha_key = await solverTaskResult(svc, apiKey, cr.taskId);
    if (captchaData.captcha_rqtoken) formData.captcha_rqtoken = captchaData.captcha_rqtoken;
    const hdrs = JSON.stringify({ 'Content-Type': 'application/json', ...s.captchaHeaders });
    const loginApi = () => s.page.evaluate(`(async()=>{var r=await fetch('/api/v9/auth/login',{method:'POST',headers:${hdrs},body:${JSON.stringify(JSON.stringify(formData))}});return{status:r.status,data:await r.json().catch(()=>({}))};})()`);
    const finishWithToken = async (token) => {
      await s.page.evaluate(`localStorage.setItem("token", JSON.stringify(${JSON.stringify(token)}))`);
      // Discord auth lives in localStorage, so persist it beside the account
      // cookies in the same Skarbiec item.
      if (acct.id) await s.patchAccount(acct.id, { metadata: { discord_token: token } });
      await s.goto('https://discord.com/channels/@me');
      await pageSettled(s.page);
      console.log(`PASS: logged in as ${acct.username} — ${s.page.url?.()}`);
      await captureCookies();
    };
    const result = await loginApi();
    console.log(`[login] ${svc.name}: status=${result?.status} response=${(JSON.stringify(result?.data) ?? '')}`);
    if (result?.status === 200 && result?.data?.token) {
      await finishWithToken(result.data.token);
    } else if (result?.data?.captcha_rqdata) {
      throw new Error(`discord_login: Discord rejected the ${svc.name} captcha answer and issued a new captcha challenge`);
    } else if (result?.data?.errors?.login?._errors?.some(e => e.code === 'ACCOUNT_LOGIN_VERIFICATION_EMAIL')) {
      // Login location verification — open the authorize-ip link from the
      // mail, then re-submit the login API call.
      console.log('[login] New location verification required, checking email...');
      const email = formData.login;
      const loginAttemptTs = Date.now() - 30000; // mails older than this attempt belong to earlier logins
      const emails = await listReceived(10, email);
      const verifyMail = (emails.data || []).find((em) => {
        const to = (em.to || []).map(t => typeof t === 'string' ? t : t.email).join(',');
        return to.includes(email) && em.subject?.includes('Login') && new Date(em.created_at).getTime() >= loginAttemptTs;
      });
      if (!verifyMail) throw new Error(`discord_login: no new-location verification mail for ${email} has arrived yet; run the login again once it is in the inbox`);
      const full = await getReceived(verifyMail.id);
      const links = (full.html || '').match(/https:\/\/click\.discord\.com[^\s"]+/g) || [];
      let authorizeLink = null;
      for (const link of links) {
        const resp = await fetch(link, { redirect: 'manual' });
        const loc = resp.headers.get('location') || '';
        if (loc.includes('authorize-ip')) { authorizeLink = loc; break; }
      }
      if (!authorizeLink) throw new Error(`discord_login: verification mail ${verifyMail.id} carries no authorize-ip link`);
      console.log('[login] Found authorize-ip link, opening in new tab...');
      const newPage = await s.ctx.newPage();
      const authorized = newPage.waitForResponse((resp) => resp.url().includes('authorize-ip') && resp.request().method() === 'POST');
      await newPage.goto(authorizeLink, { waitUntil: 'domcontentloaded' });
      const authorizeResponse = await authorized;
      console.log(`[login] authorize-ip API: ${authorizeResponse.status()}`);
      await newPage.close();
      await pageSettled(s.page);
      // After IP authorize, re-fire the /api/v9/auth/login XHR directly
      // (same path the captcha-success branch uses).
      console.log('[login] IP authorized, retrying login API directly...');
      const retryResult = await loginApi();
      console.log(`[login] post-authorize retry: status=${retryResult?.status} response=${(JSON.stringify(retryResult?.data) ?? '')}`);
      if (retryResult?.status === 200 && retryResult?.data?.token) {
        await finishWithToken(retryResult.data.token);
      } else if (retryResult?.data?.captcha_rqdata) {
        throw new Error('discord_login: Discord asks for a new captcha after the IP authorization');
      } else if ((s.page.url?.() ?? '').includes('/channels')) {
        console.log(`PASS: logged in as ${acct.username} — ${s.page.url()}`);
        await captureCookies();
      } else {
        throw new Error(`discord_login: login API answered ${retryResult?.status} after the IP authorization, at ${s.page.url?.()}`);
      }
    } else {
      throw new Error(`discord_login: login API answered ${result?.status} with ${(JSON.stringify(result?.data) ?? '')}`);
    }
  } else {
    // No captcha — check if already logged in
    const url2 = s.page.url?.() ?? '';
    if (url2.includes('/channels')) {
      console.log('PASS: logged in');
      await captureCookies();
    } else {
      throw new Error(`discord_login: the login form answered without a captcha challenge and without logging in, at ${url2}`);
    }
  }
} catch (e) {
  // Structured ban_signal so the worker doesn't fall back to 'unknown_error'.
  // Discord login fails in three distinct shapes: chrome-error proxy CONNECT,
  // hCaptcha widget appearance (login is gated until solved), or invalid
  // creds → /login still showing. Emit the right one.
  try {
    const path = await import('node:path');
    const fs = await import('node:fs');
    const dir = runRecordingsDir('discord_login');
    fs.mkdirSync(dir, { recursive: true });
    const finalUrl = s?.page?.url?.() ?? '';
    const msg = e.message ?? '';
    let sig = 'action_failed';
    if (/ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED_BY_ADMINISTRATOR/.test(msg)) sig = 'ip_blocked';
    else if (/ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CONNECTION_FAILED/.test(msg)) sig = 'proxy_failed';
    else if (finalUrl.startsWith('chrome-error://')) sig = 'proxy_failed';
    else if (/hcaptcha|captcha/i.test(msg) || /\/login/.test(finalUrl)) sig = 'checkpoint';
    fs.writeFileSync(path.join(dir, 'ban_signal.json'), JSON.stringify({ account_id: acct.id, username: acct.username, action: 'discord_login', signal: sig, healthy: false, details: { final_url: finalUrl, reason: e.message ?? 'no message' }, ts: new Date().toISOString() }, null, 2));
  } catch {}
  console.log('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await s.close();
}
