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

import fs from 'node:fs';
import path from 'node:path';
import { getNumber, pollCode, cancelOrder } from '../../../dist/utils/sms.js';

const DEFAULT_INVITES = 'python,discord-developers,reactjs,nextjs,rust-lang,godotengine,unity-developer-community';

async function discordApi(token, apiPath, opts = {}) {
  const headers = { Authorization: token, 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const r = await fetch('https://discord.com/api/v9' + apiPath, { ...opts, headers });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { /* not json */ }
  return { status: r.status, body: j ?? t };
}

// Solve an enterprise hCaptcha via anticaptcha. Discord's phone-verify
// dispatch returns 400 with captcha_sitekey + captcha_rqdata + captcha_rqtoken
// on first attempt; the resubmit must carry the solved token.
async function solveHCaptcha(sitekey, rqdata) {
  const apiKey = process.env.ANTICAPTCHA_API_KEY || process.env.CAPSOLVER_API_KEY;
  if (!apiKey) { console.log('[captcha] no ANTICAPTCHA_API_KEY / CAPSOLVER_API_KEY'); return null; }
  const isCs = !!process.env.CAPSOLVER_API_KEY && !process.env.ANTICAPTCHA_API_KEY;
  const base = isCs ? 'https://api.capsolver.com' : 'https://api.anti-captcha.com';
  const taskType = isCs ? 'HCaptchaEnterpriseTaskProxyLess' : 'HCaptchaTaskProxyless';
  const task = { type: taskType, websiteURL: 'https://discord.com', websiteKey: sitekey, enterprisePayload: { rqdata }, ...(isCs ? {} : { isEnterprise: true }) };
  const cr = await (await fetch(base + '/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, task }) })).json();
  if (cr.errorId) { console.log(`[captcha] createTask err: ${cr.errorCode}`); return null; }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 5000)); // allow-raw-playwright: solver-poll cadence
    const res = await (await fetch(base + '/getTaskResult', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: apiKey, taskId: cr.taskId }) })).json();
    if (res.status === 'ready') return res.solution?.gRecaptchaResponse ?? res.solution?.token;
    if (res.errorId) { console.log(`[captcha] solver err: ${res.errorCode}`); return null; }
  }
  return null;
}

// Try the dispatch with one number; returns { ok, num, dispatch, reason }
// where ok=true means the SMS was actually dispatched (status 204/200) so
// the caller can poll for the code. If Discord rejects the number with
// 50022 (Invalid phone number — VOIP detected) or similar, returns ok=false
// so the caller can skip the order and try a different number/country.
async function tryDispatch(token, country) {
  const num = await getNumber('discord', country);
  if (!num) return { ok: false, reason: 'no_number', country };
  console.log(`[phone-verify] try ${country} number=${num.phone} order=${num.orderId}`);
  let dispatch = await discordApi(token, '/users/@me/phone', { method: 'POST', body: JSON.stringify({ phone: num.phone }) });
  if (dispatch.status === 400 && dispatch.body?.captcha_sitekey) {
    const captchaToken = await solveHCaptcha(dispatch.body.captcha_sitekey, dispatch.body.captcha_rqdata);
    if (!captchaToken) { await cancelOrder(num.orderId, num.provider); return { ok: false, reason: 'captcha_solve_failed', num }; }
    const body = { phone: num.phone, captcha_key: captchaToken };
    if (dispatch.body.captcha_rqtoken) body.captcha_rqtoken = dispatch.body.captcha_rqtoken;
    dispatch = await discordApi(token, '/users/@me/phone', { method: 'POST', body: JSON.stringify(body) });
  }
  if (dispatch.status !== 204 && dispatch.status !== 200) {
    console.log(`[phone-verify] ${country} dispatch status=${dispatch.status} body=${JSON.stringify(dispatch.body).slice(0, 160)}`);
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
  const COUNTRIES = (process.env.DISCORD_PHONE_COUNTRIES || 'US,UK,CA,NL,DE').split(',');
  const MAX_NUMBERS = parseInt(process.env.DISCORD_PHONE_MAX_TRIES || '6', 10);
  let dispatched = null;
  let tries = 0;
  for (const country of COUNTRIES) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (tries++ >= MAX_NUMBERS) break;
      const r = await tryDispatch(token, country);
      if (r.ok) { dispatched = r; break; }
      if (r.reason === 'no_number') break; // move on to next country
    }
    if (dispatched) break;
  }
  if (!dispatched) { console.log(`[phone-verify] exhausted ${tries} attempts, no working number`); return { ok: false, reason: 'no_working_number' }; }
  const { num } = dispatched;
  console.log(`[phone-verify] SMS dispatched to ${num.phone} (${num.country}), polling...`);
  const code = await pollCode(num.orderId, num.provider, 180);
  if (!code) { console.log('[phone-verify] no code received'); return { ok: false, reason: 'no_code' }; }
  console.log(`[phone-verify] got code ${code}, submitting confirm...`);
  let confirm = await discordApi(token, '/users/@me/phone', { method: 'POST', body: JSON.stringify({ code }) });
  if (confirm.status === 400 && confirm.body?.captcha_sitekey) {
    const captchaToken = await solveHCaptcha(confirm.body.captcha_sitekey, confirm.body.captcha_rqdata);
    if (!captchaToken) return { ok: false, reason: 'confirm_captcha_failed' };
    const body = { code, captcha_key: captchaToken };
    if (confirm.body.captcha_rqtoken) body.captcha_rqtoken = confirm.body.captcha_rqtoken;
    confirm = await discordApi(token, '/users/@me/phone', { method: 'POST', body: JSON.stringify(body) });
  }
  if (confirm.status !== 200 && confirm.status !== 204) {
    console.log(`[phone-verify] confirm status=${confirm.status} body=${JSON.stringify(confirm.body).slice(0, 200)}`);
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
  if (join.status !== 200) { console.log(`[harvest] /invites/${code} POST status=${join.status} body=${JSON.stringify(join.body).slice(0, 200)}`); return null; }
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
    await new Promise(r => setTimeout(r, 300)); // allow-raw-playwright: API rate-limit pacing, not browser interaction
  }
  return authors;
}

async function persistTokenAndPhone(username, newToken, phone) {
  const supaUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supaUrl || !supaKey) return;
  const cur = await (await fetch(`${supaUrl}/rest/v1/social_accounts?platform=eq.discord&username=eq.${encodeURIComponent(username)}&select=id,metadata`, { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } })).json();
  if (!cur || !cur[0]) return;
  const merged = { ...(cur[0].metadata || {}) };
  if (newToken) merged.discord_token = newToken;
  if (phone) merged.phone_verified = phone;
  await fetch(`${supaUrl}/rest/v1/social_accounts?id=eq.${cur[0].id}`, { method: 'PATCH', headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' }, body: JSON.stringify({ metadata: merged }) });
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
    try { existing = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') console.log(`[harvest] read err: ${e.message?.slice(0, 80)}`); }
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
  } catch (e) { console.log(`[harvest] err: ${e.message?.slice(0, 200)}`); }
}
