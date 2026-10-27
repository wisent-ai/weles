// Discord registration on one sticky exit. The form is filled like a person
// fills it; the submit's captcha challenge (an enterprise hCaptcha Discord's
// /auth/register answer carries, which the session intercepts) is solved by
// the first solving service whose key is configured, its token pushed back to
// the run once the task is solved, and the registration is sent again with it from the page.
// An exit Discord flags for hCaptcha rejects every solver token: that exit is
// marked burned (resolveProxy skips burned IPs) and the run fails naming it,
// so the next run starts on a fresh exit. After the account is saved, the
// verify link of Discord's verification mail is opened once the mail arrives.
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import { exitStatusFor } from '../../../dist/cli/usage.js';
import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';
// burned.js is CommonJS; its export is read from the default import.
import burnedMod from '../../../dist/proxy/burned.js';
import { pageCondition, pageSettled } from '../_shared/page/settled.mjs';
import { apiSolve } from '../../../dist/captcha/providers/api.js';
import { autoBindCharacter } from '../lib/character-bind.mjs';
import { accountItemFor } from '../_shared/skarbiec/accounts.mjs';
import { messagesTo } from '../../_shared/mail/skrzynka-inbox.mjs';
import { statedProxy } from '../_shared/inputs/stated.mjs';

const { markBurned } = burnedMod;
const SIGNUP_URL = 'https://discord.com/register';
// The form's birth-date comboboxes and text inputs, each with the generated
// identity value it takes.
const BIRTH_DATE = [
  { combobox: 'month', value: '$DISCORD_NEW_BIRTHMONTH' },
  { combobox: 'day', value: '$DISCORD_NEW_BIRTHDAY' },
  { combobox: 'year', value: '$DISCORD_NEW_BIRTHYEAR' },
];
const TEXT_INPUTS = [
  { name: 'email', value: '$DISCORD_NEW_EMAIL' },
  { name: 'global_name', value: '$DISCORD_NEW_USERNAME' },
  { name: 'username', value: '$DISCORD_NEW_USERNAME' },
  { name: 'password', value: '$DISCORD_NEW_PASSWORD' },
];
const SOLVERS = [
  {
    name: 'anticaptcha',
    url: 'https://api.anti-captcha.com',
    envKey: 'ANTICAPTCHA_API_KEY',
  },
  {
    name: 'capsolver',
    url: 'https://api.capsolver.com',
    envKey: 'CAPSOLVER_API_KEY',
  },
  {
    name: 'capmonster',
    url: 'https://api.capmonster.cloud',
    envKey: 'CAPMONSTERCLOUD_API_KEY',
  },
  {
    name: '2captcha',
    url: 'https://api.2captcha.com',
    envKey: 'TWOCAPTCHA_API_KEY',
  },
];

/** The exit address of the session's proxy: the one resolveProxy recorded, else its gateway host; null without a proxy. */
function exitAddress(proxy) {
  if (!proxy) return null;
  return proxy.exit_ip ? proxy.exit_ip : new URL(proxy.server).hostname;
}

/** Whether `address` is one of this machine's own internal interface addresses. */
function onThisMachine(address) {
  return Object.values(networkInterfaces())
    .flat()
    .some((nic) => nic.internal && nic.address === address);
}

/**
 * The proxy fields of the solver's task: the session's own gateway by
 * address, which the services require; a proxy only this machine can reach
 * is replaced by the public tunnel CAPTCHA_PROXY_URL names, and without one
 * the task is solved proxyless.
 */
async function solverProxyFields(proxy) {
  if (!proxy) return null;
  const gateway = new URL(proxy.server);
  const { address } = await lookup(gateway.hostname);
  if (!onThisMachine(address))
    return {
      proxyType: 'http',
      proxyAddress: address,
      proxyPort: Number(gateway.port),
      proxyLogin: proxy.username,
      proxyPassword: proxy.password,
    };
  const tunnel = process.env.CAPTCHA_PROXY_URL;
  if (!tunnel) {
    console.log(
      `[register] the proxy ${gateway.host} is local and CAPTCHA_PROXY_URL names no tunnel; solving proxyless`,
    );
    return null;
  }
  const t = new URL(tunnel);
  console.log(`[register] captcha via tunnel proxy ${t.host}`);
  return {
    proxyType: 'http',
    proxyAddress: t.hostname,
    proxyPort: Number(t.port),
    proxyLogin: decodeURIComponent(t.username),
    proxyPassword: decodeURIComponent(t.password),
  };
}

/** The token the first configured solving service returns for Discord's challenge. */
async function solveChallenge(s, challenge) {
  const svc = SOLVERS.find((candidate) => process.env[candidate.envKey]);
  if (!svc)
    throw new Error(
      `discord_register: no captcha solver key is configured (${SOLVERS.map((c) => c.envKey).join(', ')})`,
    );
  const apiKey = process.env[svc.envKey];
  const proxyFields = await solverProxyFields(s.proxyConfig);
  // CapSolver names its enterprise tasks; the others take isEnterprise.
  const capsolver = svc.name === 'capsolver';
  const proxied = capsolver ? 'HCaptchaEnterpriseTask' : 'HCaptchaTask';
  const proxyless = capsolver
    ? 'HCaptchaEnterpriseTaskProxyLess'
    : 'HCaptchaTaskProxyless';
  const task = {
    type: proxyFields ? proxied : proxyless,
    websiteURL: SIGNUP_URL,
    websiteKey: challenge.captcha_sitekey,
    enterprisePayload: { rqdata: challenge.captcha_rqdata },
    userAgent: await s.page.evaluate('navigator.userAgent'),
    ...proxyFields,
    ...(capsolver ? {} : { isEnterprise: true }),
  };
  return {
    solver: svc.name,
    token: await apiSolve(svc.url, apiKey, task),
  };
}

/** The /verify address the newest Discord mail to `address` links to, once that mail arrives. */
async function verifyLink(address) {
  for (;;) {
    const [newest] = await messagesTo(address, 'discord.com');
    if (newest) {
      for (const [link] of newest.body_text.matchAll(
        /https:\/\/click\.discord\.com[^\s"]+/g,
      )) {
        const redirect = await fetch(link, { redirect: 'manual' });
        const location = redirect.headers.get('location');
        if (location && new URL(location).pathname.startsWith('/verify'))
          return location;
      }
      throw new Error(
        `discord_register: the newest mail from discord.com to ${address} ("${newest.subject}") links to no /verify page`,
      );
    }
  }
}

async function fillSignupForm(s) {
  await s.goto(SIGNUP_URL);
  // Discord's app mounts after Cloudflare lets its JS run; the birth-date
  // comboboxes render after the text inputs.
  await pageCondition(
    s.page,
    () => document.querySelector('#app-mount')?.children?.length > 0,
  );
  await pageCondition(
    s.page,
    (parts) => document.querySelectorAll('[role=combobox]').length >= parts,
    BIRTH_DATE.length,
  );
  for (const { combobox, value } of BIRTH_DATE) {
    const result = await s.select(combobox, value);
    if (!result.startsWith('selected'))
      throw new Error(
        `discord_register: date-of-birth ${combobox} could not be selected (${result})`,
      );
  }
  await pageSettled(s.page);
  // Text fields are filled after the birth date, whose selection resets them.
  for (const { name, value } of TEXT_INPUTS) {
    const input = s.page.locator(`input[name="${name}"]`).first();
    if (!(await input.count()))
      throw new Error(`discord_register: the form has no input "${name}"`);
    await humanFill(s.page, input, s.resolveEnv(value));
  }
  await pageSettled(s.page);
  await humanClickLocator(
    s.page,
    s.page.locator('[class*="checkboxOption"]').first(),
  );
  await pageSettled(s.page);
  const submit = s.page.locator('button[type="submit"]').first();
  if (!(await submit.count()))
    throw new Error('discord_register: the form has no submit button');
  if (await submit.isDisabled())
    throw new Error(
      'discord_register: the submit button is disabled, so the form did not validate',
    );
  await humanClickLocator(s.page, submit);
  await pageSettled(s.page);
}

const s = await WSession.start({
  label: 'discord_register',
  proxy: statedProxy('the Discord signup'),
  targetHost: 'discord.com',
});
const exit = exitAddress(s.proxyConfig);
console.log(`[register] exit=${exit === null ? 'no proxy' : exit}`);
try {
  const id = await s.generateIdentity('discord');
  await fillSignupForm(s);
  const challenge = s.captchaResponse;
  const form = s.captchaFormData;
  if (!challenge || !form) {
    if (exit) await markBurned(exit, 'action_failed', 'discord');
    throw new Error(
      `discord_register: the submit produced no captcha challenge to solve, at ${s.page.url()}`,
    );
  }
  const solved = await solveChallenge(s, challenge);
  form.captcha_key = solved.token;
  if (challenge.captcha_rqtoken)
    form.captcha_rqtoken = challenge.captcha_rqtoken;
  const headers = { 'Content-Type': 'application/json', ...s.captchaHeaders };
  const result = await s.page.evaluate(
    async ({ headers, body }) => {
      const answer = await fetch('/api/v9/auth/register', {
        method: 'POST',
        headers,
        body,
      });
      return {
        ok: answer.ok,
        status: answer.status,
        data: await answer.json(),
      };
    },
    { headers, body: JSON.stringify(form) },
  );
  console.log(
    `[register] ${solved.solver}: status=${result.status} response=${JSON.stringify(result.data)}`,
  );
  if (!result.ok || !result.data.token) {
    if (result.data.captcha_rqdata && exit) {
      await markBurned(exit, 'captcha_challenge', 'discord');
      throw new Error(
        `discord_register: Discord rejected the ${solved.solver} token and asked for a new captcha; exit ${exit} marked burned`,
      );
    }
    throw new Error(
      `discord_register: register API answered ${result.status} with ${JSON.stringify(result.data)}`,
    );
  }
  const authToken = result.data.token;
  await s.page.evaluate(
    (token) => localStorage.setItem('token', JSON.stringify(token)),
    authToken,
  );
  await s.goto('https://discord.com/channels/@me');
  await pageSettled(s.page);
  await s.saveAccount('discord', {
    username: id.username,
    email: id.email,
    password: id.password,
  });
  // Cookies alone do not authenticate Discord's client; its token is kept on the same item.
  await s.patchAccount(accountItemFor('discord', id.username), {
    metadata: { discord_token: authToken },
  });
  console.log(
    `[bind] ${JSON.stringify(await autoBindCharacter(id.username, 'discord'))}`,
  );
  await s.goto(await verifyLink(s.resolveEnv('$DISCORD_NEW_EMAIL')));
  await pageSettled(s.page);
  console.log(`PASS: ${id.username} registered and verified (${s.page.url()})`);
} catch (error) {
  console.log(`FAIL: ${error.message}`);
  process.exitCode = exitStatusFor(error);
} finally {
  await s.close();
}
