// reCAPTCHA v2 and v3 tokens from the remote providers, tried in the order
// their provenance has proven useful, with the in-page tile solver as the
// last resort for v2. Moved out of the CaptchaSolver class; the class keeps
// the credential loading and calls these with its credentials.
import { solveRecaptchaV2 as solveRecaptchaV2InPage } from '../recaptcha.js';
import { costTracker } from '../../utils/runtime/cost.js';
import { markCaptchaChallenge, markAllProvidersFailed } from '../events.js';
import { apiSolve, nopechaProxyFields, proxyTaskFields, type CaptchaCredentials, type ProxyCredentials } from './api.js';

type Page = any;

export async function solveRecaptchaV2Token(creds: CaptchaCredentials, page: Page, sitekey: string, options?: { enterprise?: boolean; invisible?: boolean; url?: string; proxy?: ProxyCredentials; dataS?: string }): Promise<string | boolean | null> {
  markCaptchaChallenge();  // G8: a challenge was faced (flips challenge_faced even if every provider fails)
  const url = options?.url ?? (typeof page?.url === 'function' ? page.url() : page?.url) ?? '';
  const isInv = !!options?.invisible;
  const isEnt = !!options?.enterprise;
  const proxy = await proxyTaskFields(options?.proxy).catch((e: any) => { console.log(`[captcha:solver] proxy parse skipped: ${e.message?.slice(0, 80)}`); return null; });

  // NopeCHA Token API first — different token provenance may bypass LinkedIn rejection.
  if (creds.nopecha) {
    const token = await solveRecaptchaV2Nopecha(creds, sitekey, url, isInv, isEnt, options?.proxy, options?.dataS);
    if (token) { console.log('[captcha:solver] V2 solved via nopecha'); costTracker.recordCaptcha('nopecha', 'recaptcha_v2'); return token; }
  }

  // CapMonster: try enterprise first, then standard (with invisible flag when applicable).
  if (creds.capmonster) {
    const types: string[] = [];
    if (isEnt) types.push(proxy ? 'RecaptchaV2EnterpriseTask' : 'RecaptchaV2EnterpriseTaskProxyless');
    types.push(proxy ? 'NoCaptchaTask' : 'NoCaptchaTaskProxyless');
    for (const tType of types) {
      const task: Record<string, any> = { type: tType, websiteURL: url, websiteKey: sitekey };
      if ((tType === 'NoCaptchaTask' || tType === 'NoCaptchaTaskProxyless') && isInv) task.isInvisible = true;
      if (options?.dataS) {
        if (tType === 'RecaptchaV2EnterpriseTask' || tType === 'RecaptchaV2EnterpriseTaskProxyless') {
          task.enterprisePayload = { s: options.dataS };
        } else {
          task.recaptchaDataSValue = options.dataS;
        }
      }
      if (proxy) Object.assign(task, proxy);
      const t = await apiSolve('https://api.capmonster.cloud', creds.capmonster, task);
      if (t) { console.log(`[captcha:solver] ${tType} solved via capmonster`); costTracker.recordCaptcha('capmonster', 'recaptcha_v2'); return t; }
    }
  }
  // CapSolver: try enterprise first, then standard (with invisible flag when applicable).
  if (creds.capsolver) {
    const types: string[] = [];
    if (isEnt) types.push(proxy ? 'ReCaptchaV2EnterpriseTask' : 'ReCaptchaV2EnterpriseTaskProxyLess');
    types.push(proxy ? 'ReCaptchaV2Task' : 'ReCaptchaV2TaskProxyLess');
    for (const taskType of types) {
      const task: Record<string, any> = { type: taskType, websiteURL: url, websiteKey: sitekey };
      if (isInv) task.isInvisible = true;
      if (options?.dataS && (taskType === 'ReCaptchaV2EnterpriseTask' || taskType === 'ReCaptchaV2EnterpriseTaskProxyLess')) {
        task.enterprisePayload = { s: options.dataS };
      }
      if (proxy) Object.assign(task, proxy);
      const token = await apiSolve('https://api.capsolver.com', creds.capsolver, task);
      if (token) { console.log(`[captcha:solver] ${taskType} solved via capsolver`); costTracker.recordCaptcha('capsolver', 'recaptcha_v2'); return token; }
    }
  }
  // AntiCaptcha.
  if (creds.anticaptcha) {
    const task: Record<string, any> = { type: proxy ? 'RecaptchaV2Task' : 'RecaptchaV2TaskProxyless', websiteURL: url, websiteKey: sitekey, isEnterprise: isEnt };
    if (isInv) task.isInvisible = true;
    if (options?.dataS) task.recaptchaDataSValue = options.dataS;
    if (proxy) Object.assign(task, proxy);
    const token = await apiSolve('https://api.anti-captcha.com', creds.anticaptcha, task);
    if (token) { console.log(`[captcha:solver] V2 solved via anticaptcha`); costTracker.recordCaptcha('anticaptcha', 'recaptcha_v2'); return token; }
  }
  // 2captcha fallback.
  if (creds.twocaptcha) {
    const token = await solveRecaptchaV2TwoCaptcha(creds, sitekey, url, isInv, isEnt, options?.proxy, options?.dataS);
    if (token) { console.log('[captcha:solver] V2 solved via 2captcha'); costTracker.recordCaptcha('twocaptcha', 'recaptcha_v2'); return token; }
  }
  // Image-grid path for cases where API solvers fail and Google's
  // standard frame chain IS present (non-LinkedIn enterprise sites).
  if (isEnt) return solveRecaptchaV2InPage(page);
  markAllProvidersFailed('recaptcha_v2');  // G8
  return null;
}

async function solveRecaptchaV2TwoCaptcha(creds: CaptchaCredentials, sitekey: string, url: string, invisible: boolean, enterprise: boolean, proxy?: ProxyCredentials, dataS?: string): Promise<string | null> {
  const params = new URLSearchParams({
    key: creds.twocaptcha!,
    method: 'userrecaptcha',
    googlekey: sitekey,
    pageurl: url,
    json: '1',
  });
  if (invisible) params.set('invisible', '1');
  if (enterprise) params.set('enterprise', '1');
  if (dataS) params.set('data-s', dataS);
  if (proxy?.server) {
    const u = new URL(proxy.server);
    const proxyAddr = `${u.hostname}:${u.port}`;
    const proxyType = u.protocol.replace(':', '');
    params.set('proxy', proxy.username ? `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password ?? '')}@${proxyAddr}` : proxyAddr);
    params.set('proxytype', proxyType);
  }
  console.log('[captcha:api] 2captcha recaptcha v2 create');
  const cr = await (await fetch('https://2captcha.com/in.php?' + params.toString())).json().catch(() => ({})) as any;
  if (cr.status !== 1 || !cr.request) { console.log(`[captcha:api] 2captcha create error: ${cr.request ?? cr.error_text ?? JSON.stringify(cr)}`); return null; }
  const tid = cr.request;
  console.log(`[captcha:api] 2captcha taskId=${tid}`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
    const res = await (await fetch(`https://2captcha.com/res.php?key=${creds.twocaptcha}&action=get&id=${tid}&json=1`)).json().catch(() => ({})) as any;
    if (res.status === 1) { console.log('[captcha:api] 2captcha solved'); return res.request; }
    if (res.request !== 'CAPCHA_NOT_READY') { console.log(`[captcha:api] 2captcha error: ${res.request}`); return null; }
  }
  console.log('[captcha:api] 2captcha timed out after 60 polls');
  return null;
}

async function solveRecaptchaV2Nopecha(creds: CaptchaCredentials, sitekey: string, url: string, invisible: boolean, enterprise: boolean, proxy?: ProxyCredentials, dataS?: string): Promise<string | null> {
  const k = creds.nopecha; if (!k) return null;
  const body: Record<string, any> = { sitekey, url };
  const data: Record<string, any> = { theme: 'light' };
  if (dataS) data.s = dataS;
  if (invisible) data.invisible = true;
  if (Object.keys(data).length) body.data = data;
  if (enterprise) body.enterprise = true;
  const np = nopechaProxyFields(proxy);
  if (np) body.proxy = np;
  console.log(`[captcha:api] nopecha recaptcha2 create enterprise=${enterprise} invisible=${invisible} proxy=${!!np}`);
  try {
    const post = await (await fetch('https://api.nopecha.com/v1/token/recaptcha2', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${k}` },
      body: JSON.stringify(body),
    })).json() as any;
    const jobId = post?.data; if (!jobId) { console.log(`[captcha:api] nopecha recaptcha2 no jobId: ${JSON.stringify(post).slice(0, 200)}`); return null; }
    console.log(`[captcha:api] nopecha recaptcha2 jobId=${jobId}`);
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
      const res = await (await fetch(`https://api.nopecha.com/v1/token/recaptcha2?id=${jobId}`, { headers: { 'Authorization': `Basic ${k}` } })).json() as any;
      if (typeof res?.data === 'string' && res.data.length > 20) { console.log(`[captcha:api] nopecha recaptcha2 solved token=${res.data.slice(0, 20)}...`); return res.data; }
      if (res?.error && res.error !== 14) { console.log(`[captcha:api] nopecha recaptcha2 error: ${JSON.stringify(res).slice(0, 200)}`); return null; }
    }
    console.log('[captcha:api] nopecha recaptcha2 timed out after 60 polls');
  } catch (e: any) { console.log(`[captcha:api] nopecha recaptcha2 fetch err: ${e.message?.slice(0, 100)}`); }
  return null;
}

async function solveRecaptchaV3Nopecha(creds: CaptchaCredentials, sitekey: string, url: string, action?: string, proxy?: ProxyCredentials, dataS?: string, enterprise?: boolean): Promise<string | null> {
  const k = creds.nopecha; if (!k) return null;
  const body: Record<string, any> = { sitekey, url };
  const data: Record<string, any> = { action: action ?? 'verify', theme: 'light' };
  if (dataS) data.s = dataS;
  body.data = data;
  if (enterprise) body.enterprise = true;
  const np = nopechaProxyFields(proxy);
  if (np) body.proxy = np;
  console.log(`[captcha:api] nopecha recaptcha3 create action=${data.action} enterprise=${!!enterprise} proxy=${!!np}`);
  try {
    const post = await (await fetch('https://api.nopecha.com/v1/token/recaptcha3', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Basic ${k}` },
      body: JSON.stringify(body),
    })).json() as any;
    const jobId = post?.data; if (!jobId) { console.log(`[captcha:api] nopecha recaptcha3 no jobId: ${JSON.stringify(post).slice(0, 200)}`); return null; }
    console.log(`[captcha:api] nopecha recaptcha3 jobId=${jobId}`);
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
      const res = await (await fetch(`https://api.nopecha.com/v1/token/recaptcha3?id=${jobId}`, { headers: { 'Authorization': `Basic ${k}` } })).json() as any;
      if (typeof res?.data === 'string' && res.data.length > 20) { console.log(`[captcha:api] nopecha recaptcha3 solved token=${res.data.slice(0, 20)}...`); return res.data; }
      if (res?.error && res.error !== 14) { console.log(`[captcha:api] nopecha recaptcha3 error: ${JSON.stringify(res).slice(0, 200)}`); return null; }
    }
    console.log('[captcha:api] nopecha recaptcha3 timed out after 60 polls');
  } catch (e: any) { console.log(`[captcha:api] nopecha recaptcha3 fetch err: ${e.message?.slice(0, 100)}`); }
  return null;
}

export async function solveRecaptchaV3Token(creds: CaptchaCredentials, sitekey: string, url: string, action?: string, options?: { proxy?: ProxyCredentials; dataS?: string; enterprise?: boolean }): Promise<string | null> {
  markCaptchaChallenge();  // G8
  // NopeCHA V3 first.
  if (creds.nopecha) {
    const token = await solveRecaptchaV3Nopecha(creds, sitekey, url, action, options?.proxy, options?.dataS, options?.enterprise);
    if (token) { console.log('[captcha:solver] ReCaptchaV3 solved via nopecha'); costTracker.recordCaptcha('nopecha', 'recaptcha_v3'); return token; }
  }
  // CapSolver V3 first (enterprise + non-enterprise), then AntiCaptcha.
  if (creds.capsolver) {
    const token = await apiSolve('https://api.capsolver.com', creds.capsolver, {
      type: 'ReCaptchaV3EnterpriseTaskProxyLess', websiteURL: url, websiteKey: sitekey,
      minScore: 0.9, pageAction: action ?? 'verify',
    });
    if (token) { console.log('[captcha:solver] ReCaptchaV3Enterprise solved via capsolver'); costTracker.recordCaptcha('capsolver', 'recaptcha_v3'); return token; }
    const tokenV3 = await apiSolve('https://api.capsolver.com', creds.capsolver, {
      type: 'ReCaptchaV3TaskProxyLess', websiteURL: url, websiteKey: sitekey,
      minScore: 0.9, pageAction: action ?? 'verify',
    });
    if (tokenV3) { console.log('[captcha:solver] ReCaptchaV3 solved via capsolver'); costTracker.recordCaptcha('capsolver', 'recaptcha_v3'); return tokenV3; }
  }
  if (creds.anticaptcha) {
    const token = await apiSolve('https://api.anti-captcha.com', creds.anticaptcha, {
      type: 'RecaptchaV3TaskProxyless', websiteURL: url, websiteKey: sitekey,
      minScore: 0.7, pageAction: action ?? 'verify',
    });
    if (token) { console.log('[captcha:solver] ReCaptchaV3 solved via anticaptcha'); costTracker.recordCaptcha('anticaptcha', 'recaptcha_v3'); return token; }
  }
  markAllProvidersFailed('recaptcha_v3');  // G8
  return null;
}
