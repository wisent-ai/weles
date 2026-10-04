// Post-register Discord helper: phone-verify the freshly created account
// via juicysms (Discord blocks every server-interaction endpoint behind
// phone verification, returning HTTP 403 code 40002 on every fresh
// email-verified-only account), then drive the avatar-survey harvest via
// the Discord API directly. The SPA path (localStorage.token injection
// via addInitScript) does NOT authenticate the web client for fresh
// accounts — /channels/@me always redirects to /login — but the same
// token works fine on /api/v9/*.
//
// Gated by DISCORD_HARVEST_AFTER_REGISTER=1 so default register behavior
// is unchanged.

import { runOutputPath } from '#run-output';
import fs from 'node:fs';
import path from 'node:path';
import { getNumber, readCode, cancelOrder } from '../../../dist/utils/identity/sms.js';
import { solverTaskResult } from '../_shared/captcha/solver_task.mjs';
import { findAccount, updateAccountMetadata } from '../_shared/skarbiec/accounts.mjs';

const DEFAULT_INVITES = 'python,discord-developers,reactjs,nextjs,rust-lang,godotengine,unity-developer-community';

async function discordApi(token, apiPath, opts = {}) {
  const headers = { Authorization: token, 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const r = await fetch('https://discord.com/api/v9' + apiPath, { ...opts, headers });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, body: j ?? t };
}

// Solve an enterprise hCaptcha with the first provider in env that accepts
// the task (anticaptcha, capsolver, capmonster, 2captcha). Discord's
// enterprise hCaptcha on /users/@me/phone breaks at some vendors at task
// creation (anticaptcha hits ERROR_FAILED_LOADING_WIDGET), so a refused
// createTask moves on to the next vendor. The result is read once: a task the
// solver is still working on is a named error carrying its task id.
async function solveHCaptcha(sitekey, rqdata) {
  const services = [
    { name: 'anticaptcha', url: 'https://api.anti-captcha.com', env: 'ANTICAPTCHA_API_KEY', task: 'HCaptchaTaskProxyless', enterprise: true },
    { name: 'capsolver', url: 'https://api.capsolver.com', env: 'CAPSOLVER_API_KEY', task: 'HCaptchaEnterpriseTaskProxyLess', enterprise: false },
    { name: 'capmonster', url: 'https://api.capmonster.cloud', env: 'CAPMONSTERCLOUD_API_KEY', task: 'HCaptchaTaskProxyless', enterprise: true },
    { name: '2captcha', url: 'https://api.2captcha.com', env: 'TWOCAPTCHA_API_KEY', task: 'HCaptchaTaskProxyless', enterprise: true },
  ];
  const refusals = [];
  for (const svc of services) {
    const apiKey = process.env[svc.env];
    if (!apiKey) { refusals.push(`${svc.name}: no ${svc.env}`); continue; }
    const task = { type: svc.task, websiteURL: 'https://discord.com', websiteKey: sitekey, enterprisePayload: { rqdata }, ...(svc.enterprise ? { isEnterprise: true } : {}) };
    const cr = await (await fetch(svc.url + '/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, task }) })).json();
    if (cr.errorId) { refusals.push(`${svc.name}: ${cr.errorCode}`); continue; }
    console.log(`[captcha] ${svc.name} task ${cr.taskId} created`);
    return solverTaskResult(svc, apiKey, cr.taskId);
  }
  throw new Error(`discord_harvest: no captcha vendor accepted the hCaptcha task (${refusals.join('; ')})`);
}

// Try the dispatch with one number; returns { ok, num, dispatch, reason }
// where ok=true means the SMS was actually dispatched (status 204/200) so
// the caller can poll for the code. If Discord rejects the number with
// 50022 (Invalid phone number — VOIP detected) or similar, returns ok=false
// so the caller can skip the order and try a different number/country.
// Mark a juicysms number as bad so the pool issues a different one next
// time. cancelOrder just refunds; skipnumber blacklists the number for
// this customer. Critical when Discord 50022 keeps re-targeting the same
// VOIP-detected number across orders.
async function skipJuicySmsNumber(orderId) {
  const k = process.env.JUICYSMS_API_KEY;
  if (!k) return;
  try { await fetch(`https://juicysms.com/api/skipnumber?key=${k}&orderId=${orderId}`); }
  catch (e) { console.log(`[sms] skipnumber err: ${e.message}`); }
}

async function tryDispatch(token, country) {
  const num = await getNumber('discord', country);
  if (!num) return { ok: false, reason: 'no_number', country };
  console.log(`[phone-verify] try ${country} number=${num.phone} order=${num.orderId}`);
  let dispatch = await discordApi(token, '/users/@me/phone', { method: 'POST', body: JSON.stringify({ phone: num.phone }) });
  if (dispatch.status === 400 && dispatch.body?.captcha_sitekey) {
    const captchaToken = await solveHCaptcha(dispatch.body.captcha_sitekey, dispatch.body.captcha_rqdata);
    const body = { phone: num.phone, captcha_key: captchaToken };
    if (dispatch.body.captcha_rqtoken) body.captcha_rqtoken = dispatch.body.captcha_rqtoken;
    dispatch = await discordApi(token, '/users/@me/phone', { method: 'POST', body: JSON.stringify(body) });
  }
  if (dispatch.status === 429 && dispatch.body?.retry_after) {
    // Discord says when this number may be tried again; the caller gets that
    // instead of this run waiting it out.
    const retryAfter = Math.ceil(dispatch.body.retry_after);
    console.log(`[phone-verify] ${country} rate-limited for ${retryAfter}s`);
    await cancelOrder(num.orderId, num.provider);
    return { ok: false, reason: 'rate_limited', num, retry_after: retryAfter };
  }
  // 50022 = Invalid phone number (VOIP detected). Skip the number on the
  // juicysms side so the pool issues a different one — cancelOrder alone
  // lets juicysms re-issue the same flagged number.
  if (dispatch.status === 400 && dispatch.body?.code === 50022) {
    console.log(`[phone-verify] ${country} 50022 VOIP-rejected — skipping number on juicysms`);
    if (num.provider === 'juicysms') await skipJuicySmsNumber(num.orderId);
    else await cancelOrder(num.orderId, num.provider);
    return { ok: false, reason: 'voip', num };
  }
  if (dispatch.status !== 204 && dispatch.status !== 200) {
    console.log(`[phone-verify] ${country} dispatch status=${dispatch.status} body=${JSON.stringify(dispatch.body)}`);
    await cancelOrder(num.orderId, num.provider);
    return { ok: false, reason: `dispatch_${dispatch.body?.code || dispatch.status}`, num };
  }
  return { ok: true, num, dispatch };
}

// Discord phone-verify with multi-country, multi-number search. Discord
// rejects VOIP-pool numbers with code 50022 (Invalid phone number). juicysms
// US pool returns the same flagged number repeatedly, so the dispatch loop
// tries US first then UK, then CA, skipping rejected numbers (cancelOrder
// frees them server-side — free retry since no SMS was sent).
// retry-allowed: SMS-provider number-pool exhaustion search is a single
// logical operation across countries+numbers; first-call-only would mean
// giving up on Discord phone-verify after one VOIP number is rejected.
async function phoneVerify(token) {
  // Which countries to search and how many numbers to spend are the
  // operator's: DISCORD_PHONE_COUNTRIES and DISCORD_PHONE_MAX_TRIES, both
  // required.
  const COUNTRIES = (process.env.DISCORD_PHONE_COUNTRIES || '').split(',').map((c) => c.trim()).filter(Boolean);
  if (!COUNTRIES.length) return { ok: false, reason: 'DISCORD_PHONE_COUNTRIES must list the SMS countries to search, comma-separated' };
  const MAX_NUMBERS = Number(process.env.DISCORD_PHONE_MAX_TRIES);
  if (!Number.isInteger(MAX_NUMBERS) || MAX_NUMBERS <= 0) return { ok: false, reason: 'DISCORD_PHONE_MAX_TRIES must say how many numbers to spend (a positive whole number)' };
  let dispatched = null;
  let tries = 0;
  // retry-allowed: pool-exhaustion search across countries+numbers is one
  // logical operation, bounded by MAX_NUMBERS; first-call-only would mean
  // giving up after one VOIP rejection.
  for (const country of COUNTRIES) {
    // retry-allowed: a country's pool may issue the same number again before
    // skipnumber kicks in; it is asked until it has no number or the
    // operator's number budget is spent.
    while (tries < MAX_NUMBERS) {
      tries += 1;
      const r = await tryDispatch(token, country);
      if (r.ok) { dispatched = r; break; }
      if (r.reason === 'no_number') break; // move on to next country
    }
    if (dispatched) break;
  }
  if (!dispatched) { console.log(`[phone-verify] exhausted ${tries} attempts, no working number`); return { ok: false, reason: 'no_working_number' }; }
  const { num } = dispatched;
  console.log(`[phone-verify] SMS dispatched to ${num.phone} (${num.country}), reading the order...`);
  const code = await readCode(num.orderId, num.provider);
  console.log(`[phone-verify] got code ${code}, submitting confirm...`);
  let confirm = await discordApi(token, '/users/@me/phone', { method: 'POST', body: JSON.stringify({ code }) });
  if (confirm.status === 400 && confirm.body?.captcha_sitekey) {
    const captchaToken = await solveHCaptcha(confirm.body.captcha_sitekey, confirm.body.captcha_rqdata);
    const body = { code, captcha_key: captchaToken };
    if (confirm.body.captcha_rqtoken) body.captcha_rqtoken = confirm.body.captcha_rqtoken;
    confirm = await discordApi(token, '/users/@me/phone', { method: 'POST', body: JSON.stringify(body) });
  }
  if (confirm.status !== 200 && confirm.status !== 204) {
    console.log(`[phone-verify] confirm status=${confirm.status} body=${JSON.stringify(confirm.body)}`);
    return { ok: false, reason: 'confirm_failed', detail: confirm };
  }
  const newToken = confirm.body?.token;
  console.log(`[phone-verify] verified — token rotated=${!!newToken}`);
  return { ok: true, phone: num.phone, newToken: newToken || null };
}

async function joinByInvite(token, code) {
  const meta = await discordApi(token, `/invites/${code}?with_counts=true`);
  if (meta.status !== 200) { console.log(`[harvest] /invites/${code} GET status=${meta.status}`); return null; }
  const join = await discordApi(token, `/invites/${code}`, { method: 'POST', body: '{}' });
  if (join.status !== 200) { console.log(`[harvest] /invites/${code} POST status=${join.status} body=${JSON.stringify(join.body)}`); return null; }
  return { guild: join.body.guild || meta.body.guild, channel: join.body.channel || meta.body.channel };
}

async function listTextChannels(token, guildId) {
  const r = await discordApi(token, `/guilds/${guildId}/channels`);
  if (r.status !== 200) { console.log(`[harvest] /guilds/${guildId}/channels status=${r.status}`); return []; }
  return (r.body || []).filter(c => c.type === 0); // GUILD_TEXT
}

async function harvestChannelAuthors(token, channelId, want, seen) {
  const authors = [];
  let before = null;
  for (let page = 0; page < 60 && authors.length < want; page++) {
    const q = before ? `?limit=100&before=${before}` : '?limit=100';
    const r = await discordApi(token, `/channels/${channelId}/messages${q}`);
    if (r.status !== 200) { console.log(`[harvest] msgs ch=${channelId} status=${r.status}`); break; }
    const msgs = r.body || [];
    if (!msgs.length) break;
    for (const m of msgs) {
      const a = m.author;
      if (!a || !a.avatar || a.bot) continue;
      const key = String(a.id).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      authors.push({ id: a.id, username: a.username, global_name: a.global_name, avatar: a.avatar });
    }
    before = msgs[msgs.length - 1].id;
  }
  return authors;
}

function persistTokenAndPhone(username, newToken, phone) {
  const account = findAccount('discord', username);
  if (!account) throw new Error(`Discord account ${username} is absent from Skarbiec`);
  updateAccountMetadata(account.id, {
    ...(newToken ? { discord_token: newToken } : {}),
    ...(phone ? { phone_verified: phone } : {}),
  });
}

export async function harvestAfterRegister(s, opts = {}) {
  if (process.env.DISCORD_HARVEST_AFTER_REGISTER !== '1') return;
  let token = opts.token; let username = opts.username;
  if (!token || !username) { console.log('[harvest] missing token/username in opts'); return; }
  try {
    const me = await discordApi(token, '/users/@me');
    if (me.status !== 200) { console.log(`[harvest] token validation status=${me.status} — bailing`); return; }
    console.log(`[harvest] authed as ${me.body.username} (id=${me.body.id})`);
    const probe = await discordApi(token, '/users/@me/guilds');
    if (probe.status === 403 && probe.body?.code === 40002) {
      console.log('[harvest] phone-verify required, running juicysms flow...');
      const pv = await phoneVerify(token);
      if (!pv.ok) { console.log(`[harvest] phone-verify failed: ${pv.reason} — bailing`); return; }
      if (pv.newToken) token = pv.newToken;
      await persistTokenAndPhone(username, pv.newToken, pv.phone);
      console.log('[harvest] phone-verify ok, retrying server probes');
    }
    const OUT = path.resolve(process.cwd(), '.work/avatar-survey/data/discord.json');
    const LIMIT = parseInt(process.env.DISCORD_HARVEST_LIMIT || '100', 10);
    const INVITES = (process.env.DISCORD_INVITES || DEFAULT_INVITES).split(',').map(x => x.trim());
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.log(`[harvest] read err: ${e.message}`); }
    const seen = new Set(existing.map(p => String(p.id || p.handle || '').toLowerCase()));
    const need = Math.max(0, LIMIT - existing.length);
    console.log(`[harvest] existing=${existing.length} target=${LIMIT} need=${need}`);
    if (need === 0) return;
    const collected = [];
    for (const code of INVITES) {
      if (collected.length >= need) break;
      console.log(`[harvest] joining discord.gg/${code}`);
      const j = await joinByInvite(token, code);
      if (!j || !j.guild) { console.log(`[harvest] join ${code} failed`); continue; }
      console.log(`[harvest] joined guild ${j.guild.id} (${j.guild.name || '?'})`);
      const channels = await listTextChannels(token, j.guild.id);
      console.log(`[harvest] ${channels.length} text channels in ${j.guild.name || j.guild.id}`);
      for (const ch of channels.slice(0, 20)) {
        if (collected.length >= need) break;
        const authors = await harvestChannelAuthors(token, ch.id, need - collected.length + 20, seen);
        if (authors.length > 0) console.log(`[harvest] #${ch.name}: +${authors.length} (total ${collected.length + authors.length}/${need})`);
        collected.push(...authors);
      }
    }
    const newProfiles = [];
    for (const a of collected.slice(0, need)) {
      const animated = a.avatar.startsWith('a_');
      const ext = animated ? 'gif' : 'png';
      const avatarUrl = `https://cdn.discordapp.com/avatars/${a.id}/${a.avatar}.${ext}?size=512`;
      const profile = { platform: 'discord', id: a.id, handle: a.global_name || a.username, display_name: a.global_name || a.username, bio: undefined, bio_length: 0, has_link_in_bio: false, followers_str: undefined, avatar_url: avatarUrl, avatar_is_default: false };
      try { const r = await fetch(avatarUrl); if (r.ok) { const buf = Buffer.from(await r.arrayBuffer()); profile.avatar_bytes = buf.length; } } catch (e) { /* CDN best-effort */ }
      newProfiles.push(profile);
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify([...existing, ...newProfiles], null, 2));
    console.log(`[harvest] wrote ${newProfiles.length} new profiles (total ${existing.length + newProfiles.length}) to ${OUT}`);
  } catch (e) { console.log(`[harvest] err: ${e.message}`); }
}
