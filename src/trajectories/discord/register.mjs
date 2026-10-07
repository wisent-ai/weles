import { pageCondition, pageSettled } from '../_shared/page/settled.mjs';
import { solverTaskResult } from '../_shared/captcha/solver_task.mjs';
import { WSession } from '../../../dist/session/wsession.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill } from '../../../dist/human/keyboard.js';
import { autoBindCharacter } from '../lib/character-bind.mjs';
import { harvestAfterRegister } from '../lib/discord_harvest.mjs';
import { accountItemFor } from '../_shared/skarbiec/accounts.mjs';
import {
  getReceived,
  listReceivedFrom,
} from '../../_shared/resend-receiving.mjs';
// burned.js is CommonJS; default-import then destructure (named ESM import
// of a CJS export is fragile across rebuilds). This lineage exposes
// markBurned(host,signal,platform) — no multi-level markBurnedIp.
import burnedMod from '../../../dist/proxy/burned.js';
const markBurned = burnedMod.markBurned;

const URL = 'https://discord.com/register';

// One registration attempt on one sticky exit. A residential exit that
// Discord flags for hCaptcha rejects every solver token; that exit is marked
// burned (resolveProxy skips burned IPs) and the run fails with the named
// reason, so the next run starts on a fresh exit. targetHost lets
// resolveProxy map the "residential oxylabs us" filter to a provider row +
// Discord country policy.
const s = await WSession.start({
  label: 'discord_register',
  proxy: process.env.PROXY_URL || 'residential',
  targetHost: 'discord.com',
});
const exitIp =
  s.proxyConfig?.exit_ip ||
  (s.proxyConfig?.server
    ? new globalThis.URL(s.proxyConfig.server).hostname
    : null);
console.log(`[register] exit=${exitIp ?? 'unknown'}`);

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

// The proxy the solver should use: a public tunnel for a local proxy when
// CAPTCHA_PROXY_URL is set, the session's own gateway otherwise, or none.
async function solverProxyFields(proxy) {
  const isLocalProxy =
    proxy &&
    (proxy.server.includes('127.0.0.1') || proxy.server.includes('localhost'));
  const captchaProxyUrl = process.env.CAPTCHA_PROXY_URL;
  if (isLocalProxy && captchaProxyUrl) {
    const cu = new globalThis.URL(captchaProxyUrl);
    console.log(
      `[register] Captcha via tunnel proxy: ${cu.hostname}:${cu.port}`,
    );
    return {
      proxyType: 'http',
      proxyAddress: cu.hostname,
      proxyPort: parseInt(cu.port, 10),
      proxyLogin: cu.username ? decodeURIComponent(cu.username) : undefined,
      proxyPassword: cu.password ? decodeURIComponent(cu.password) : undefined,
    };
  }
  if (proxy && !isLocalProxy) {
    const u = new globalThis.URL(proxy.server);
    const dns = await import('node:dns');
    const { address } = await dns.promises.lookup(u.hostname);
    console.log(
      `[register] Proxy for captcha: ${address}:${u.port} user=${proxy.username}`,
    );
    return {
      proxyType: 'http',
      proxyAddress: address,
      proxyPort: parseInt(u.port, 10),
      proxyLogin: proxy.username,
      proxyPassword: proxy.password,
    };
  }
  if (isLocalProxy)
    console.log(
      '[register] Local proxy, no CAPTCHA_PROXY_URL — solving proxyless',
    );
  return null;
}

// Opens the verify link of the Discord verification mail that is in the
// inbox now: a mail from a discord.com sender to this address whose body
// carries a click.discord.com link that resolves to /verify. Throws when no
// such mail has arrived.
async function verifyEmail(emailAddr) {
  const fromDiscord = await listReceivedFrom(10, emailAddr, 'discord.com');
  if (fromDiscord.length === 0)
    throw new Error(
      `discord_register: no mail from discord.com for ${emailAddr} has arrived yet; open its verify link once it is in the inbox`,
    );
  for (const mail of fromDiscord) {
    const full = await getReceived(mail.id);
    if (!full.html) continue;
    const links =
      full.html.match(/https:\/\/click\.discord\.com[^\s"]+/g) ?? [];
    for (const link of links) {
      const r = await fetch(link, { redirect: 'manual' });
      const loc = r.headers.get('location');
      if (!loc || !new globalThis.URL(loc).pathname.startsWith('/verify'))
        continue;
      console.log('[register] Opening verify link in browser...');
      await s.goto(loc);
      await pageSettled(s.page);
      console.log(`[register] After verify: ${s.page.url?.()}`);
      return;
    }
  }
  throw new Error(
    `discord_register: ${fromDiscord.length} mail(s) from discord.com for ${emailAddr} carry no click.discord.com link to /verify`,
  );
}

try {
  // Single deterministic path: hCaptcha solve via service + direct
  // /api/v9/auth/register POST. No agent loop.
  const id = await s.generateIdentity('discord');
  await s.goto(URL);
  // Discord SPA mounts after Cloudflare lets its JS run.
  await pageCondition(
    s.page,
    () => document.querySelector('#app-mount')?.children?.length > 0,
  );
  // Humanized fill — humanFill clicks, clears, then types one char at a
  // time with trace-derived timing.
  const fillField = async (name, val) => {
    const resolved = s.resolveEnv(val);
    const loc = s.page.locator(`input[name="${name}"]`).first();
    if (!(await loc.count()))
      throw new Error(`discord_register: the form has no input "${name}"`);
    await humanFill(s.page, loc, resolved);
    console.log(`[register] fill ${name}: len=${resolved.length}`);
  };
  // The date-of-birth comboboxes render after the text inputs.
  await pageCondition(
    s.page,
    () => document.querySelectorAll('[role=combobox]').length >= 3,
  );
  const select = async (target, value) => {
    const result = await s.select(target, value);
    if (!result || result.includes('no-select-found'))
      throw new Error(
        `discord_register: date-of-birth ${target} could not be selected (${result})`,
      );
  };
  await select('month', '$DISCORD_NEW_BIRTHMONTH');
  await select('day', '$DISCORD_NEW_BIRTHDAY');
  await select('year', '$DISCORD_NEW_BIRTHYEAR');
  await pageSettled(s.page);
  // Fill text fields AFTER DOB (DOB selection resets React-controlled inputs)
  await fillField('email', '$DISCORD_NEW_EMAIL');
  await fillField('global_name', '$DISCORD_NEW_USERNAME');
  await fillField('username', '$DISCORD_NEW_USERNAME');
  await fillField('password', '$DISCORD_NEW_PASSWORD');
  await pageSettled(s.page);
  // Terms checkbox — target the checkboxOption wrapper, not just the text.
  await humanClickLocator(
    s.page,
    s.page.locator('[class*="checkboxOption"]').first(),
  );
  await pageSettled(s.page);
  const formState = await s.page.evaluate(`(() => {
    var inputs = Array.from(document.querySelectorAll('input'));
    var vals = inputs.map(i => ({ name: i.name || i.type || i.placeholder, value: i.value?.slice(0, 20), type: i.type }));
    var btn = document.querySelector('button[type="submit"]');
    return { inputs: vals, hasButton: !!btn, btnDisabled: btn ? btn.disabled : null, btnText: btn?.textContent?.trim() };
  })()`);
  console.log(`[register] Form state: ${JSON.stringify(formState)}`);
  if (!formState.hasButton)
    throw new Error('discord_register: the form has no submit button');
  if (formState.btnDisabled)
    throw new Error(
      'discord_register: submit button disabled — form validation failed',
    );
  await humanClickLocator(
    s.page,
    s.page.locator('button[type="submit"]').first(),
  );
  await pageSettled(s.page);

  const captchaData = s.captchaResponse;
  const formData = s.captchaFormData;
  if (!captchaData || !formData) {
    if (exitIp) await markBurned(exitIp, 'action_failed', 'discord');
    throw new Error(
      `discord_register: the submit produced no captcha challenge to solve, at ${s.page.url()}`,
    );
  }
  const svc = SOLVERS.find((candidate) => process.env[candidate.envKey]);
  if (!svc)
    throw new Error('discord_register: no captcha solver key is configured');
  const apiKey = process.env[svc.envKey];
  const ua = await s.page.evaluate('navigator.userAgent');
  const proxyFields = await solverProxyFields(s.proxyConfig);
  const isCs = svc.name === 'capsolver';
  // CapSolver requires HCaptchaEnterpriseTaskProxyLess for enterprise sites;
  // anticaptcha uses HCaptchaTaskProxyless + isEnterprise:true.
  const taskType = isCs
    ? proxyFields
      ? 'HCaptchaEnterpriseTask'
      : 'HCaptchaEnterpriseTaskProxyLess'
    : proxyFields
      ? 'HCaptchaTask'
      : 'HCaptchaTaskProxyless';
  const task = {
    type: taskType,
    websiteURL: URL,
    websiteKey: captchaData.captcha_sitekey,
    enterprisePayload: { rqdata: captchaData.captcha_rqdata },
    userAgent: ua,
    ...(proxyFields ?? {}),
    ...(isCs ? {} : { isEnterprise: true }),
  };
  const createRes = await (
    await fetch(svc.url + '/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, task }),
    })
  ).json();
  if (createRes.errorId)
    throw new Error(
      `discord_register: ${svc.name} createTask refused: ${createRes.errorCode}`,
    );
  console.log(`[register] ${svc.name} task ${createRes.taskId} created`);
  formData.captcha_key = await solverTaskResult(svc, apiKey, createRes.taskId);
  if (captchaData.captcha_rqtoken)
    formData.captcha_rqtoken = captchaData.captcha_rqtoken;
  const hdrs = JSON.stringify({
    'Content-Type': 'application/json',
    ...s.captchaHeaders,
  });
  const result = await s.page.evaluate(
    `(async()=>{var r=await fetch('/api/v9/auth/register',{method:'POST',headers:${hdrs},body:${JSON.stringify(JSON.stringify(formData))}});return{status:r.status,data:await r.json()};})()`,
  );
  console.log(
    `[register] ${svc.name}: status=${result.status} response=${JSON.stringify(result.data)}`,
  );
  if (
    !((result.status === 200 || result.status === 201) && result.data?.token)
  ) {
    if (result.data?.captcha_rqdata && exitIp) {
      await markBurned(exitIp, 'captcha_challenge', 'discord');
      throw new Error(
        `discord_register: Discord rejected the ${svc.name} token and asked for a new captcha; exit ${exitIp} marked burned`,
      );
    }
    throw new Error(
      `discord_register: register API answered ${result.status} with ${JSON.stringify(result.data)}`,
    );
  }
  const authToken = result.data.token;
  await s.page.evaluate(
    `localStorage.setItem("token", JSON.stringify(${JSON.stringify(authToken)}))`,
  );
  await s.goto('https://discord.com/channels/@me');
  await pageSettled(s.page);
  console.log(`[register] Navigated to: ${s.page.url?.()}`);
  await s.saveAccount('discord', {
    username: id.username,
    email: id.email,
    password: id.password,
  });
  // saveAccount creates the Skarbiec item; add Discord's localStorage
  // token to that exact item because cookies alone do not authenticate.
  const item = accountItemFor('discord', id.username);
  await s.patchAccount(item, { metadata: { discord_token: authToken } });
  console.log('[register] persisted metadata.discord_token to Skarbiec');
  const bind = await autoBindCharacter(id.username, 'discord');
  console.log(`[bind] ${JSON.stringify(bind)}`);
  console.log(`PASS: ${id.username}`);
  await verifyEmail(s.resolveEnv('$DISCORD_NEW_EMAIL'));
  await harvestAfterRegister(s, { token: authToken, username: id.username }); // DISCORD_HARVEST_AFTER_REGISTER=1 gates phone-verify + API harvest
} catch (e) {
  console.log('FAIL:', e.message);
  process.exitCode = 1;
} finally {
  await s.close();
}
