// What every captcha provider call shares: the credential set, the
// createTask/getTaskResult exchange, and the proxy fields a task carries in
// the two dialects the providers speak.

export interface CaptchaCredentials {
  anticaptcha?: string;
  twocaptcha?: string;
  capsolver?: string;
  capmonster?: string;
  nocaptcha?: string;
  nopecha?: string;
}

export async function apiSolve(apiUrl: string, clientKey: string, task: Record<string, any>): Promise<string | null> {
  const svc = apiUrl.replace('https://api.', '').replace('.com', '');
  console.log(`[captcha:api] ${svc} createTask type=${task.type} enterprise=${task.isEnterprise} proxy=${!!task.proxyAddress}`);
  const createRes = await (await fetch(apiUrl + '/createTask', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey, task }),
  })).json() as any;
  if (createRes.errorId) { console.log(`[captcha:api] ${svc} createTask error: ${createRes.errorCode} ${createRes.errorDescription}`); return null; }
  const taskId = createRes.taskId;
  if (!taskId) { console.log(`[captcha:api] ${svc} no taskId in response`); return null; }
  console.log(`[captcha:api] ${svc} taskId=${taskId}`);
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000));  // allow-raw-playwright: polling/rate-limit loop
    const res = await (await fetch(apiUrl + '/getTaskResult', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey, taskId }),
    })).json() as any;
    if (res.status === 'ready') { const t = res.solution?.gRecaptchaResponse ?? res.solution?.token ?? null; console.log(`[captcha:api] ${svc} solved, token=${t?.slice(0, 20)}...`); return t; }
    if (res.errorId) { console.log(`[captcha:api] ${svc} result error: ${res.errorCode} ${res.errorDescription}`); return null; }
  }
  console.log(`[captcha:api] ${svc} timed out after 60 polls`);
  return null;
}

export type ProxyCredentials = { server?: string; username?: string; password?: string };

export async function proxyTaskFields(proxy?: ProxyCredentials): Promise<Record<string, any> | null> {
  if (!proxy?.server) return null;
  const u = new URL(proxy.server);
  const { lookup } = await import('node:dns');
  const ip = await new Promise<string>((res, rej) => lookup(u.hostname, (e: any, a: string) => e ? rej(e) : res(a)));
  return {
    proxyType: u.protocol.replace(':', '') || 'http',
    proxyAddress: ip,
    proxyPort: parseInt(u.port, 10),
    proxyLogin: proxy.username ?? '',
    proxyPassword: proxy.password ?? '',
  };
}

export function nopechaProxyFields(proxy?: ProxyCredentials): Record<string, any> | null {
  if (!proxy?.server) return null;
  const u = new URL(proxy.server);
  const out: Record<string, any> = { scheme: u.protocol.replace(':', '') || 'http', host: u.hostname, port: parseInt(u.port, 10) };
  if (proxy.username) out.username = proxy.username;
  if (proxy.password) out.password = proxy.password;
  return out;
}
