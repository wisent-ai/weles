// FunCaptcha solver helper for github_register.
// Creates one task with every configured solver (AntiCaptcha, 2captcha) and
// reads each task's result once. The solvers have no push or blocking answer,
// so a task still being solved comes back as `captcha_<solver>_processing`
// with its task id instead of this helper waiting for it.
import { solverTaskResult } from '../../_shared/captcha/solver_task.mjs';

async function createTask(svc, apiKey, { websiteURL, publicKey, apiSub, blob, userAgent, proxy }) {
  const plainSub = apiSub ?? 'github-api.arkoselabs.com';
  // Proxy mode (FunCaptchaTask) lets the solver's worker browser route through
  // our proxy so the token matches our session region. But empirically, 2captcha
  // proxy mode returns UNSOLVABLE more often than proxyless — so we only enable
  // when WELES_FUNCAPTCHA_PROXY=1. Default is proxyless.
  const useProxy = svc.name === '2captcha' && proxy?.server && process.env.WELES_FUNCAPTCHA_PROXY === '1';
  const taskType = useProxy ? 'FunCaptchaTask' : 'FunCaptchaTaskProxyless';
  const task = { type: taskType, websiteURL, websitePublicKey: publicKey };
  if (svc.includeSub) task.funcaptchaApiJSSubdomain = plainSub;
  if (userAgent && svc.includeSub) task.userAgent = userAgent;
  if (blob) task.data = JSON.stringify({ blob });
  if (useProxy) {
    const u = new URL(proxy.server);
    task.proxyType = u.protocol.replace(':', '');
    task.proxyAddress = u.hostname;
    task.proxyPort = parseInt(u.port, 10);
    if (proxy.username) task.proxyLogin = proxy.username;
    if (proxy.password) task.proxyPassword = proxy.password;
    console.log(`[funcaptcha] ${svc.name} using proxy ${task.proxyAddress}:${task.proxyPort}`);
  }
  const cr = await (await fetch(svc.url + '/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, task }) })).json();
  if (cr.errorId) throw new Error(`captcha_${svc.name}_refused: ${cr.errorCode} ${cr.errorDescription ?? ''}`.trim());
  console.log(`[funcaptcha] ${svc.name} taskId=${cr.taskId}`);
  return cr.taskId;
}

export async function solveFunCaptcha(params) {
  const allServices = [
    { name: 'anticaptcha', url: 'https://api.anti-captcha.com', envKey: 'ANTICAPTCHA_API_KEY', includeSub: true },
    { name: '2captcha', url: 'https://api.2captcha.com', envKey: 'TWOCAPTCHA_API_KEY', includeSub: true },
  ];
  const active = allServices.filter(s => process.env[s.envKey]);
  if (!active.length) throw new Error('funcaptcha: no solver API key is configured (ANTICAPTCHA_API_KEY or TWOCAPTCHA_API_KEY)');
  const results = await Promise.allSettled(active.map(async (svc) => {
    const apiKey = process.env[svc.envKey];
    const taskId = await createTask(svc, apiKey, params);
    return { token: await solverTaskResult(svc, apiKey, taskId), service: svc.name };
  }));
  const winner = results.find((r) => r.status === 'fulfilled');
  if (winner) {
    console.log(`[funcaptcha] ${winner.value.service} token_chars=${winner.value.token.length}`);
    return winner.value;
  }
  throw new Error(`funcaptcha: no solver returned a token — ${results.map((r) => r.reason.message).join('; ')}`);
}
