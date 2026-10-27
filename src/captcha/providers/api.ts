import { lookup } from 'node:dns/promises';
import { costTracker } from '../../utils/runtime/cost.js';
import { markAllProvidersFailed } from '../events.js';

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

// The answer a provider gives once it stops solving a task. The providers have
// no push or blocking answer, and no interval between reads is ours to invent:
// each read follows the provider's previous answer, so its own response time
// paces them. Reading once answered every task as unsolved, because the
// providers take longer to solve than one round trip.
export async function readUntilSolved<T>(
  read: () => Promise<T>,
  solving: (answer: T) => boolean,
): Promise<T> {
  for (;;) {
    const answer = await read();
    if (!solving(answer)) return answer;
  }
}

// A provider's answer as JSON, or an error naming the call, its HTTP status
// and the body that is not JSON, so an unparseable answer is never read as a
// refusal without its body.
export async function providerJson(
  response: Response,
  call: string,
): Promise<any> {
  const body = await response.text();
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(
      `${call} answered HTTP ${response.status} with a body that is not JSON (${error instanceof Error ? error.message : String(error)}): ${body}`,
      { cause: error },
    );
  }
}

// Creates the task and reads its result until the provider stops solving it.
// Answers the token, or throws naming the service, the task and the provider's
// refusal, so a chain can say why no service solved the challenge.
export async function apiSolve(
  apiUrl: string,
  clientKey: string,
  task: Record<string, any>,
): Promise<string> {
  const svc = apiUrl.replace('https://api.', '').replace('.com', '');
  console.log(
    `[captcha:api] ${svc} createTask type=${task.type} enterprise=${task.isEnterprise} proxy=${!!task.proxyAddress}`,
  );
  const createRes = await providerJson(
    await fetch(apiUrl + '/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey, task }),
    }),
    `${svc} createTask`,
  );
  if (createRes.errorId) {
    throw new Error(
      `${svc} refused createTask ${task.type}: ${createRes.errorCode} ${createRes.errorDescription}`,
    );
  }
  const taskId = createRes.taskId;
  if (!taskId) {
    throw new Error(
      `${svc} answered createTask ${task.type} without a taskId: ${JSON.stringify(createRes)}`,
    );
  }
  console.log(`[captcha:api] ${svc} taskId=${taskId}`);
  const res = await readUntilSolved(
    async () =>
      providerJson(
        await fetch(apiUrl + '/getTaskResult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey, taskId }),
        }),
        `${svc} getTaskResult for task ${taskId}`,
      ),
    (answer) => !answer.errorId && answer.status === 'processing',
  );
  if (res.errorId) {
    throw new Error(
      `${svc} task ${taskId} (${task.type}) failed: ${res.errorCode} ${res.errorDescription}`,
    );
  }
  if (res.status !== 'ready') {
    throw new Error(
      `${svc} task ${taskId} (${task.type}) answered status ${res.status}, neither processing nor ready: ${JSON.stringify(res)}`,
    );
  }
  // Two token fields are in use across the services: reCAPTCHA's own name and
  // the generic one. A ready task carrying neither is named, not passed on.
  const t = res.solution?.gRecaptchaResponse ?? res.solution?.token;
  if (!t) {
    throw new Error(
      `${svc} task ${taskId} (${task.type}) is ready but its solution carries no token: ${JSON.stringify(res.solution)}`,
    );
  }
  console.log(`[captcha:api] ${svc} solved, token_chars=${t.length}`);
  return t;
}

// 2captcha's in.php/res.php pair: creates the task with `params` (which carry
// `key` and json=1) and reads res.php until 2captcha stops answering
// CAPCHA_NOT_READY. `what` names the captcha in the log lines and refusals.
export async function twoCaptchaSolve(
  key: string,
  params: URLSearchParams,
  what: string,
): Promise<string> {
  console.log(`[captcha:api] 2captcha ${what} create`);
  const cr = await providerJson(
    await fetch('https://2captcha.com/in.php?' + params.toString()),
    `2captcha in.php (${what})`,
  );
  if (!cr.status || !cr.request) {
    throw new Error(
      `2captcha refused ${what}: ${JSON.stringify(cr)}`,
    );
  }
  const tid = cr.request;
  console.log(`[captcha:api] 2captcha ${what} taskId=${tid}`);
  const read = new URLSearchParams({ key, action: 'get', id: tid, json: '1' });
  const res = await readUntilSolved(
    async () =>
      providerJson(
        await fetch('https://2captcha.com/res.php?' + read.toString()),
        `2captcha res.php for task ${tid}`,
      ),
    (answer) => !answer.status && answer.request === 'CAPCHA_NOT_READY',
  );
  if (!res.status) {
    throw new Error(`2captcha task ${tid} (${what}) failed: ${JSON.stringify(res)}`);
  }
  console.log(`[captcha:api] 2captcha ${what} solved`);
  return res.request;
}

// One service's attempt in a chain: the service the cost table prices and
// the call that answers its solution (a token, or the cookies a cookie
// challenge yields) or throws why it could not.
export type ServiceAttempt<T = string> = { service: string; solve: () => Promise<T> };

// Tries each service in order; the first solution answers and is priced. When
// none solves it answers every service's cause instead, so a chain with a last
// resort of its own can try it before giving up.
export async function trySolved<T = string>(
  resource: string,
  attempts: ServiceAttempt<T>[],
): Promise<{ token: T } | { causes: string[] }> {
  const causes: string[] = [];
  for (const attempt of attempts) {
    let token: T;
    try {
      token = await attempt.solve();
    } catch (error) {
      causes.push(
        `${attempt.service}: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    // Priced outside the attempt: a solved token whose price cannot be
    // recorded is that failure, not a reason to pay the next service.
    console.log(`[captcha:solver] ${resource} solved via ${attempt.service}`);
    costTracker.recordCaptcha(attempt.service, resource);
    return { token };
  }
  return { causes };
}

// The error a challenge nobody solved ends in: the run's captcha log marks it
// all-failed with every cause, and the error lists them, so the caller learns
// why instead of reading an absent token as "try something else".
export function unsolved(resource: string, causes: string[]): Error {
  markAllProvidersFailed(resource, causes);
  if (!causes.length) {
    return new Error(`no captcha service solves ${resource} with a key Weles holds`);
  }
  return new Error(`no captcha service solved ${resource}: ${causes.join('; ')}`);
}

// The first service's solution, or the error naming every service and its cause.
export async function firstSolved<T = string>(
  resource: string,
  attempts: ServiceAttempt<T>[],
): Promise<T> {
  const outcome = await trySolved(resource, attempts);
  if ('token' in outcome) return outcome.token;
  throw unsolved(resource, outcome.causes);
}

export type ProxyCredentials = {
  server?: string;
  username?: string;
  password?: string;
};

// The proxy URL a task names, which must carry its port: the services take
// the proxy as address and port, and a URL without one read as port NaN, so
// the task went out naming no usable proxy.
function proxyUrl(server: string): URL {
  const u = new URL(server);
  if (!u.port)
    throw new Error(
      `captcha proxy ${u.hostname} names no port; the solving services need one`,
    );
  return u;
}

// The proxy fields of a createTask task. The services require the proxy by IP
// address, so a host that does not resolve fails here with its cause rather
// than going out as a name the services refuse.
export async function proxyTaskFields(
  proxy?: ProxyCredentials,
): Promise<Record<string, any> | null> {
  if (!proxy?.server) return null;
  const u = proxyUrl(proxy.server);
  let ip: string;
  try {
    ({ address: ip } = await lookup(u.hostname));
  } catch (error) {
    throw new Error(
      `captcha proxy ${u.hostname} did not resolve to an address the solving services accept: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return {
    proxyType: u.protocol.replace(':', ''),
    proxyAddress: ip,
    proxyPort: Number(u.port),
    proxyLogin: proxy.username,
    proxyPassword: proxy.password,
  };
}

export function nopechaProxyFields(
  proxy?: ProxyCredentials,
): Record<string, any> | null {
  if (!proxy?.server) return null;
  const u = proxyUrl(proxy.server);
  const out: Record<string, any> = {
    scheme: u.protocol.replace(':', ''),
    host: u.hostname,
    port: Number(u.port),
  };
  if (proxy.username) out.username = proxy.username;
  if (proxy.password) out.password = proxy.password;
  return out;
}
