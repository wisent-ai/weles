// FunCaptcha solver helper for github_register. Tries services in order; retries UNSOLVABLE up to 3x per service.
export async function solveFunCaptcha({ websiteURL, publicKey, apiSub, blob, userAgent }) {
  const plainSub = apiSub ?? 'github-api.arkoselabs.com';
  // CapSolver's minimal FunCaptchaTaskProxyLess shape (from their extension source) doesn't include funcaptchaApiJSSubdomain
  const services = [
    { name: 'capsolver', url: 'https://api.capsolver.com', envKey: 'CAPSOLVER_API_KEY', taskType: 'FunCaptchaTaskProxyLess', includeSub: false },
    { name: 'anticaptcha', url: 'https://api.anti-captcha.com', envKey: 'ANTICAPTCHA_API_KEY', taskType: 'FunCaptchaTaskProxyless', includeSub: true, sub: plainSub },
    { name: '2captcha', url: 'https://api.2captcha.com', envKey: 'TWOCAPTCHA_API_KEY', taskType: 'FunCaptchaTaskProxyless', includeSub: true, sub: plainSub },
  ];

  for (const svc of services) {
    const apiKey = process.env[svc.envKey];
    if (!apiKey) { console.log(`[funcaptcha] Skipping ${svc.name}: no key`); continue; }
    for (let retry = 0; retry < 3; retry++) {
      console.log(`[funcaptcha] ${svc.name} attempt ${retry + 1}/3`);
      const task = { type: svc.taskType, websiteURL, websitePublicKey: publicKey };
      if (svc.includeSub) task.funcaptchaApiJSSubdomain = svc.sub;
      if (userAgent && svc.includeSub) task.userAgent = userAgent;
      if (blob) task.data = JSON.stringify({ blob });
      let cr;
      try {
        cr = await (await fetch(svc.url + '/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, task }) })).json();
      } catch (e) { console.log(`[funcaptcha] ${svc.name} network: ${e.message?.slice(0, 100)}`); break; }
      if (cr.errorId) { console.log(`[funcaptcha] ${svc.name} create: ${cr.errorCode} ${cr.errorDescription?.slice(0, 120)}`); break; }
      console.log(`[funcaptcha] ${svc.name} taskId=${cr.taskId}`);
      let token = null, retryable = false;
      for (let i = 0; i < 48; i++) {
        await new Promise(r => setTimeout(r, 5000));
        let res;
        try {
          res = await (await fetch(svc.url + '/getTaskResult', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, taskId: cr.taskId }) })).json();
        } catch { continue; }
        if (res.status === 'ready') { token = res.solution?.token ?? res.solution?.gRecaptchaResponse; break; }
        if (res.errorId) {
          console.log(`[funcaptcha] ${svc.name}: ${res.errorCode} ${res.errorDescription?.slice(0, 100)}`);
          retryable = res.errorCode === 'ERROR_CAPTCHA_UNSOLVABLE';
          break;
        }
        if (i % 6 === 0) console.log(`[funcaptcha] ${svc.name} solving ${i * 5}s`);
      }
      if (token) { console.log(`[funcaptcha] ${svc.name} TOKEN: ${token.slice(0, 40)}...`); return { token, service: svc.name }; }
      if (!retryable) break;
    }
  }
  return { token: null };
}
