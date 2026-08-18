// FunCaptcha solver helper for github_register.
// Strategy: run AntiCaptcha + 2captcha tasks in parallel per round (higher throughput),
// up to N rounds. First valid token wins. Each round creates fresh tasks so
// ERROR_CAPTCHA_UNSOLVABLE from one provider doesn't waste the whole budget.

const ROUNDS = 6;
const POLL_SECONDS = 600;  // 10 min per task — AntiCaptcha sometimes takes 4-8 min

async function solveOne(svc, apiKey, { websiteURL, publicKey, apiSub, blob, userAgent, proxy }) {
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
    task.proxyType = u.protocol.replace(':', '') || 'http';
    task.proxyAddress = u.hostname;
    task.proxyPort = parseInt(u.port, 10);
    if (proxy.username) task.proxyLogin = proxy.username;
    if (proxy.password) task.proxyPassword = proxy.password;
    console.log(`[funcaptcha] ${svc.name} using proxy ${task.proxyAddress}:${task.proxyPort}`);
  }
  let cr;
  try { cr = await (await fetch(svc.url + '/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, task }) })).json(); }
  catch (e) { return { err: `network: ${e.message?.slice(0, 80)}` }; }
  if (cr.errorId) return { err: `${cr.errorCode} ${cr.errorDescription?.slice(0, 100)}`, fatal: cr.errorCode !== 'ERROR_CAPTCHA_UNSOLVABLE' };
  console.log(`[funcaptcha] ${svc.name} taskId=${cr.taskId}`);
  for (let i = 0; i < POLL_SECONDS / 5; i++) {
    await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
    let res;
    try { res = await (await fetch(svc.url + '/getTaskResult', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, taskId: cr.taskId }) })).json(); }
    catch { continue; }
    if (res.status === 'ready') return { token: res.solution?.token ?? res.solution?.gRecaptchaResponse };
    if (res.errorId) return { err: `${res.errorCode} ${res.errorDescription?.slice(0, 100)}`, fatal: res.errorCode !== 'ERROR_CAPTCHA_UNSOLVABLE' };
    if (i % 12 === 0 && i > 0) console.log(`[funcaptcha] ${svc.name} solving ${i * 5}s (taskId=${cr.taskId})`);
  }
  return { err: 'polling exceeded' };
}

export async function solveFunCaptcha(params) {
  const allServices = [
    { name: 'anticaptcha', url: 'https://api.anti-captcha.com', envKey: 'ANTICAPTCHA_API_KEY', taskType: 'FunCaptchaTaskProxyless', includeSub: true },
    { name: '2captcha', url: 'https://api.2captcha.com', envKey: 'TWOCAPTCHA_API_KEY', taskType: 'FunCaptchaTaskProxyless', includeSub: true },
  ];
  const active = allServices.filter(s => process.env[s.envKey]);
  if (!active.length) { console.log('[funcaptcha] No solver API keys configured'); return { token: null }; }
  const fatalServices = new Set();

  for (let round = 1; round <= ROUNDS; round++) {
    const toRun = active.filter(s => !fatalServices.has(s.name));
    if (!toRun.length) { console.log('[funcaptcha] All solver services exhausted'); break; }
    console.log(`[funcaptcha] Round ${round}/${ROUNDS}: ${toRun.map(s => s.name).join(', ')} in parallel`);
    const results = await Promise.all(toRun.map(svc => solveOne(svc, process.env[svc.envKey], params).then(r => ({ ...r, svc: svc.name }))));
    const winner = results.find(r => r.token);
    if (winner) { console.log(`[funcaptcha] ${winner.svc} TOKEN round ${round}: ${winner.token.slice(0, 40)}...`); return { token: winner.token, service: winner.svc, round }; }
    for (const r of results) {
      console.log(`[funcaptcha] Round ${round} ${r.svc}: ${r.err}`);
      if (r.fatal) fatalServices.add(r.svc);
    }
  }
  return { token: null };
}
