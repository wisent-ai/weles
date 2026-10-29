import { costTracker } from '../../utils/runtime/cost.js';
import { markAllProvidersFailed } from '../events.js';
import {
  bodyKind,
  providerCallback,
  type ProviderAnswer,
  type ProviderCallback,
} from './callback.js';

// What every captcha provider call shares: the credential set and the
// createTask/getTaskResult exchange. The proxy fields a reCAPTCHA task
// carries are in recaptcha/proxy.ts.

export interface CaptchaCredentials {
  anticaptcha?: string;
  twocaptcha?: string;
  capsolver?: string;
  capmonster?: string;
  nocaptcha?: string;
  nopecha?: string;
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

// What a provider pushed, read as JSON, or an error naming the task and the
// body that is not JSON.
function pushedJson(answer: ProviderAnswer, what: string): any {
  try {
    return JSON.parse(answer.body);
  } catch (error) {
    throw new Error(
      `${what} was answered with ${bodyKind(answer)} that is not JSON (${error instanceof Error ? error.message : String(error)}): ${answer.body}`,
      { cause: error },
    );
  }
}

// The service name an API address carries: https://api.capsolver.com is
// capsolver, https://api.anti-captcha.com is anti-captcha.
function serviceOf(apiUrl: string): string {
  return apiUrl.replace('https://api.', '').replace('.com', '');
}

// Runs `create`, and when it fails stops waiting at the callback before the
// failure is passed on: a task the provider never accepted is never answered.
async function orAbandoned<T>(
  callback: ProviderCallback,
  create: () => Promise<T>,
): Promise<T> {
  try {
    return await create();
  } catch (error) {
    await callback.abandon();
    throw error;
  }
}

// Creates `task` on a createTask/getTaskResult service with the callback of
// this run, waits for the answer the service pushes there (it carries what
// getTaskResult would answer) and answers it once the task is ready. Throws
// naming the service, the task and the service's refusal, so a chain can say
// why no service solved the challenge.
export async function solvedTask(
  apiUrl: string,
  clientKey: string,
  task: Record<string, any>,
): Promise<any> {
  const svc = serviceOf(apiUrl);
  const callback = await providerCallback(svc);
  console.log(
    `[captcha:api] ${svc} createTask type=${task.type} enterprise=${task.isEnterprise} proxy=${!!task.proxyAddress}`,
  );
  const taskId = await orAbandoned(callback, async () => {
    const createRes = await providerJson(
      await fetch(apiUrl + '/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey, task, callbackUrl: callback.url }),
      }),
      `${svc} createTask`,
    );
    if (createRes.errorId) {
      throw new Error(
        `${svc} refused createTask ${task.type}: ${createRes.errorCode} ${createRes.errorDescription}`,
      );
    }
    if (!createRes.taskId) {
      throw new Error(
        `${svc} answered createTask ${task.type} without a taskId: ${JSON.stringify(createRes)}`,
      );
    }
    return createRes.taskId;
  });
  console.log(
    `[captcha:api] ${svc} taskId=${taskId}, waiting for its answer at the callback`,
  );
  const res = pushedJson(
    await callback.answer(),
    `${svc} task ${taskId} (${task.type})`,
  );
  if (res.errorId) {
    throw new Error(
      `${svc} task ${taskId} (${task.type}) failed: ${res.errorCode} ${res.errorDescription}`,
    );
  }
  if (res.status !== 'ready') {
    throw new Error(
      `${svc} task ${taskId} (${task.type}) pushed status ${res.status}, not ready: ${JSON.stringify(res)}`,
    );
  }
  return { ...res, taskId };
}

// The token of a solved task. Two token fields are in use across the
// services: reCAPTCHA's own name and the generic one. A ready task carrying
// neither is named, not passed on.
export async function apiSolve(
  apiUrl: string,
  clientKey: string,
  task: Record<string, any>,
): Promise<string> {
  const res = await solvedTask(apiUrl, clientKey, task);
  const t = res.solution?.gRecaptchaResponse ?? res.solution?.token;
  if (!t) {
    throw new Error(
      `${serviceOf(apiUrl)} task ${res.taskId} (${task.type}) is ready but its solution carries no token: ${JSON.stringify(res.solution)}`,
    );
  }
  console.log(
    `[captcha:api] ${serviceOf(apiUrl)} solved, token_chars=${t.length}`,
  );
  return t;
}

// 2captcha's in.php: creates the task with `params` (which carry `key` and
// json=1) and this run's callback as its pingback, then waits for the id and
// code 2captcha POSTs there as a form. 2captcha only pings back to a domain
// registered on the account; in.php refuses any other, and that refusal is
// named. `what` names the captcha in the log lines and refusals.
export async function twoCaptchaSolve(
  params: URLSearchParams,
  what: string,
): Promise<string> {
  const callback = await providerCallback('2captcha');
  params.set('pingback', callback.url);
  console.log(`[captcha:api] 2captcha ${what} create`);
  const tid = await orAbandoned(callback, async () => {
    const cr = await providerJson(
      await fetch('https://2captcha.com/in.php?' + params.toString()),
      `2captcha in.php (${what})`,
    );
    if (!cr.status || !cr.request) {
      throw new Error(`2captcha refused ${what}: ${JSON.stringify(cr)}`);
    }
    return cr.request;
  });
  console.log(
    `[captcha:api] 2captcha ${what} taskId=${tid}, waiting for its pingback`,
  );
  const pushed = await callback.answer();
  const form = new URLSearchParams(pushed.body);
  const code = form.get('code');
  if (form.get('id') !== String(tid) || !code) {
    throw new Error(
      `2captcha task ${tid} (${what}) pinged back without its id and code, with ${bodyKind(pushed)}: ${pushed.body}`,
    );
  }
  console.log(`[captcha:api] 2captcha ${what} solved`);
  return code;
}

// One service's attempt in a chain: the service the cost table prices and
// the call that answers its solution (a token, or the cookies a cookie
// challenge yields) or throws why it could not.
export type ServiceAttempt<T = string> = {
  service: string;
  solve: () => Promise<T>;
};

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
    return new Error(
      `no captcha service solves ${resource} with a key Weles holds`,
    );
  }
  return new Error(
    `no captcha service solved ${resource}: ${causes.join('; ')}`,
  );
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
