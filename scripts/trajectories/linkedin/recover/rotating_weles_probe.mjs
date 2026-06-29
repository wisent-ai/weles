/**
 * Browser-level Weles probe for rotating LinkedIn signup exits.
 *
 * This does not submit account data. It samples sticky rotating proxy sessions,
 * launches Weles with each proxy URL, opens /signup, and classifies whether the
 * browser sees a usable signup form or a challenge page.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WSession } from '../../../../dist/session/wsession.js';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import { getLinkedinChallengeSignal } from '../../_shared/linkedin/register_guard.mjs';
import { verifyExitCountry, verifyExitReputation } from '../../../../dist/proxy/policy.js';

const OUT = runRecordingsDir('linkedin_rotating_weles_probe');
const WORK = join(process.cwd(), '.work', 'linkedin_rotating_weles_probe');
mkdirSync(OUT, { recursive: true });
mkdirSync(WORK, { recursive: true });

const SAMPLES_PER_PROVIDER = Math.max(1, Number(process.env.LINKEDIN_WPROBE_SAMPLES || 1));
const TARGET_CC = (process.env.LINKEDIN_WPROBE_COUNTRY || 'us').toLowerCase();
const SUBMIT_CANDIDATE = process.env.LINKEDIN_WPROBE_SUBMIT === '1';
const STOP_AFTER_SUBMIT = process.env.LINKEDIN_WPROBE_STOP_AFTER_SUBMIT !== '0';
const PROBE_OS = process.env.LINKEDIN_WPROBE_OS || 'windows';
const INCLUDE = new Set(String(process.env.LINKEDIN_WPROBE_INCLUDE || 'oxylabs mobile,oxylabs residential,packetstream,bright data')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean));

function hash(value) {
  const text = String(value ?? '');
  return text ? createHash('sha256').update(text).digest('hex').slice(0, 16) : '';
}

function envPassName(userEnv = '') {
  return userEnv.replace('USERNAME', 'PASSWORD').replace('API_KEY', 'PASSWORD');
}

function includeRow(row) {
  const name = String(row.display_name || '').toLowerCase();
  const host = String(row.proxy_host || '').toLowerCase();
  if (name.includes('isp')) return false;
  for (const token of INCLUDE) {
    if (name.includes(token) || host.includes(token)) return true;
    if (token === 'oxylabs mobile' && name.includes('oxylabs') && name.includes('mobile')) return true;
    if (token === 'oxylabs residential' && name.includes('oxylabs') && name.includes('residential')) return true;
    if (token === 'bright data' && name.includes('bright')) return true;
  }
  return false;
}

function providerKey(row) {
  const name = String(row.display_name || '').toLowerCase();
  if (name.includes('oxylabs')) return 'oxylabs';
  if (name.includes('iproyal')) return 'iproyal';
  if (name.includes('bright')) return 'brightdata';
  if (name.includes('pingproxies')) return 'pingproxies';
  if (name.includes('packetstream')) return 'packetstream';
  return name.replace(/[^a-z0-9]+/g, '_') || 'unknown';
}

function buildStickyAuth(row, username, password, sessId, cc) {
  const name = String(row.display_name || '').toLowerCase();
  const host = String(row.proxy_host || '').toLowerCase();
  const metadata = row.metadata || {};
  const city = String(metadata.city_overrides?.linkedin || metadata.city || '')
    .toLowerCase()
    .replace(/\s+/g, '_');

  if (name.includes('oxylabs') || host.includes('oxylabs')) {
    const raw = username.startsWith('customer-') ? username.replace(/^customer-/, '') : username;
    const cityPart = city ? `-city-${city}` : '';
    return { username: `customer-${raw}-cc-${cc}${cityPart}-sessid-${sessId}`, password };
  }
  if (name.includes('packetstream') || host.includes('packetstream')) {
    return { username, password: `${password}_country-${cc.toUpperCase()}_session-${sessId}` };
  }
  if (name.includes('iproyal') || host.includes('iproyal')) {
    return { username, password: `${password}_country-${cc}_session-${sessId}` };
  }
  if (name.includes('pingproxies') || host.includes('pingproxies')) {
    return { username: `${username}_c_${cc}_s_${sessId}`, password };
  }
  if (name.includes('bright') || host.includes('brd.superproxy.io')) {
    return { username: `${username}-country-${cc}-session-${sessId}`, password };
  }
  return { username, password };
}

function proxyUrlFor(row, username, password) {
  return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${row.proxy_host}:${row.proxy_port}`;
}

function sampleExitIp(proxyUrl) {
  try {
    return execFileSync('curl', ['-sS', '--max-time', '8', '-x', proxyUrl, 'https://api.ipify.org'], {
      encoding: 'utf8',
      maxBuffer: 128 * 1024,
    }).trim();
  } catch {
    return '';
  }
}

async function fetchRows() {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) throw new Error('missing Supabase env');
  const url = `${supabaseUrl}/rest/v1/service_credentials?category=eq.proxy&proxy_host=not.is.null&select=display_name,proxy_host,proxy_port,api_key_env_var,metadata&order=display_name.asc`;
  const res = await fetch(url, { headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` } });
  if (!res.ok) throw new Error(`service_credentials fetch failed: ${res.status}`);
  return await res.json();
}

async function summarizeSignup(page) {
  return await page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden';
    };
    return {
      url: location.href,
      title: document.title,
      pageKey: document.querySelector('meta[name="pageKey"]')?.getAttribute('content') || '',
      bodyText: (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 800),
      inputs: Array.from(document.querySelectorAll('input')).map((i) => ({
        name: i.name,
        id: i.id,
        type: i.type,
        autocomplete: i.getAttribute('autocomplete') || '',
        visible: visible(i),
      })).slice(0, 30),
      buttons: Array.from(document.querySelectorAll('button,a')).filter(visible).map((el) => ({
        tag: el.tagName.toLowerCase(),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        href: el instanceof HTMLAnchorElement ? el.href : '',
      })).slice(0, 30),
      iframes: Array.from(document.querySelectorAll('iframe')).map((f) => ({
        id: f.id,
        name: f.name,
        title: f.title,
        src: f.src,
        visible: visible(f),
        width: Math.round(f.getBoundingClientRect().width),
        height: Math.round(f.getBoundingClientRect().height),
      })).slice(0, 30),
    };
  });
}

function classifySummary(summary) {
  const signal = getLinkedinChallengeSignal(summary);
  const visibleInputs = new Set((summary.inputs || []).filter((i) => i.visible).flatMap((i) => [i.name, i.id, i.type]));
  const buttonText = (summary.buttons || []).map((b) => b.text).join(' ');
  const hasSignupFields =
    (visibleInputs.has('email-address') || visibleInputs.has('email')) &&
    visibleInputs.has('password') &&
    /Agree & Join|Continue/i.test(buttonText);
  if (signal) return { result: 'challenge', signal };
  if (hasSignupFields) return { result: 'form', signal: '' };
  return { result: 'unknown', signal: '' };
}

function redactText(text = '') {
  return String(text)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<redacted-email>')
    .replace(/("(?:password|email|emailAddress|firstName|lastName|first-name|last-name|csrfToken|loginCsrfParam)"\s*:\s*)"[^"]*"/gi, '$1"<redacted>"')
    .slice(0, 3000);
}

async function summarizeApiResponse(res) {
  if (!res) return null;
  let bodyText = '';
  let bodyJson = null;
  try {
    bodyText = await res.text();
    bodyJson = JSON.parse(bodyText);
  } catch {}
  return {
    status: res.status(),
    url: res.url(),
    body_keys: bodyJson && typeof bodyJson === 'object' ? Object.keys(bodyJson).slice(0, 40) : null,
    has_challenge_url: Boolean(bodyJson?.challengeUrl),
    challenge_url_prefix: bodyJson?.challengeUrl ? String(bodyJson.challengeUrl).slice(0, 180) : '',
    body_redacted: redactText(bodyText),
  };
}

async function linkedinAuthState(session) {
  const cookies = await session.ctx.cookies().catch(() => []);
  const linkedinCookies = cookies.filter((c) => /linkedin\.com$/.test(c.domain ?? ''));
  return {
    final_url: session.page.url(),
    linkedin_cookie_count: linkedinCookies.length,
    has_li_at: linkedinCookies.some((c) => c.name === 'li_at' && c.value),
  };
}

async function submitSignupCandidate(session) {
  const id = session.identity;
  if (!id?.email || !id?.password) throw new Error('missing generated identity');
  const out = {
    attempted: true,
    identity_hashes: {
      email: hash(id.email),
      username: hash(id.username),
      full_name: hash(`${id.firstName} ${id.lastName}`),
    },
    submit1: null,
    create_account: null,
    challenge: null,
    auth: null,
    result: 'unknown',
  };

  const emailLoc = session.page.locator('input[name="email-address"], input#email-address, input[type="email"]').filter({ visible: true }).first();
  const pwdLoc = session.page.locator('input[name="password"], input#password, input[type="password"]').filter({ visible: true }).first();
  await emailLoc.waitFor({ state: 'visible', timeout: 8000 });
  await pwdLoc.waitFor({ state: 'visible', timeout: 8000 });
  await humanFill(session.page, emailLoc, id.email);
  await humanIdlePause('short');
  await humanFill(session.page, pwdLoc, id.password);
  await humanIdlePause('deliberate');

  const submit1Req = session.page.waitForRequest((r) => /\/signup\/api\//.test(r.url()), { timeout: 12_000 }).catch(() => null);
  const submit1Res = session.page.waitForResponse((r) => /\/signup\/api\//.test(r.url()), { timeout: 12_000 }).catch(() => null);
  await humanClickLocator(session.page, session.page.locator('button[type="submit"]:has-text("Agree"), button[type="submit"]:has-text("Continue"), button#join-form-submit').first());
  await humanIdlePause('deliberate');
  const [s1Req, s1Res] = await Promise.all([submit1Req, submit1Res]);
  out.submit1 = {
    request_url: s1Req?.url?.() ?? '',
    response: await summarizeApiResponse(s1Res),
    summary: await summarizeSignup(session.page).catch(() => null),
  };
  const afterSubmit1 = out.submit1.summary ? classifySummary(out.submit1.summary) : { result: 'unknown', signal: '' };
  if (afterSubmit1.signal) {
    out.result = 'challenge_after_email_password';
    return out;
  }

  const firstLoc = session.page.locator('input[name="first-name"], input#first-name').filter({ visible: true }).first();
  const lastLoc = session.page.locator('input[name="last-name"], input#last-name').filter({ visible: true }).first();
  const firstVisible = await firstLoc.isVisible({ timeout: 12_000 }).catch(() => false);
  const lastVisible = await lastLoc.isVisible({ timeout: 3000 }).catch(() => false);
  if (!firstVisible || !lastVisible) {
    out.result = 'no_first_last_after_email_password';
    out.auth = await linkedinAuthState(session);
    return out;
  }

  await humanFill(session.page, firstLoc, id.firstName);
  await humanIdlePause('short');
  await humanFill(session.page, lastLoc, id.lastName);
  await humanIdlePause('deliberate');

  const createReq = session.page.waitForRequest((r) => /\/signup\/api\/cors\/createAccount/.test(r.url()), { timeout: 20_000 }).catch(() => null);
  const createRes = session.page.waitForResponse((r) => /\/signup\/api\/cors\/createAccount/.test(r.url()), { timeout: 20_000 }).catch(() => null);
  await humanClickLocator(session.page, session.page.locator('button[type="submit"]:has-text("Continue"), button#join-form-submit').first());
  const [cReq, cRes] = await Promise.all([createReq, createRes]);
  const createSummary = await summarizeApiResponse(cRes);
  out.create_account = {
    request_url: cReq?.url?.() ?? '',
    response: createSummary,
  };

  if (createSummary?.has_challenge_url) {
    const challengeUrl = new URL(createSummary.challenge_url_prefix, 'https://www.linkedin.com/').toString();
    await session.page.goto(challengeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    await humanIdlePause('deliberate');
    const challengeSummary = await summarizeSignup(session.page).catch(() => null);
    out.challenge = {
      url: session.page.url(),
      summary: challengeSummary,
      signal: challengeSummary ? getLinkedinChallengeSignal(challengeSummary) : '',
    };
    out.result = out.challenge.signal || 'create_account_challenge';
    out.auth = await linkedinAuthState(session);
    return out;
  }

  await humanIdlePause('long');
  out.auth = await linkedinAuthState(session);
  if (out.auth.has_li_at) {
    out.result = 'accepted_authenticated';
    await session.saveAccount('linkedin', {
      username: id.username,
      email: id.email,
      password: id.password,
      name: `${id.firstName} ${id.lastName}`,
      status: 'created_by_rotating_weles_probe',
    }).catch((e) => {
      out.save_error = String(e?.message ?? e).slice(0, 200);
    });
  } else if (/verify|email-verification|checkpoint/.test(out.auth.final_url)) {
    out.result = 'verification_or_checkpoint';
  } else {
    out.result = 'create_account_no_auth';
  }
  return out;
}

const rows = (await fetchRows()).filter(includeRow);
const startedAt = new Date().toISOString();
const results = [];
let submitted = false;

console.log(`[wprobe] providers=${rows.length} samples=${SAMPLES_PER_PROVIDER} cc=${TARGET_CC} submit=${SUBMIT_CANDIDATE} os=${PROBE_OS}`);

for (const row of rows) {
  if (submitted && STOP_AFTER_SUBMIT) break;
  const userEnv = row.api_key_env_var || '';
  const passEnv = envPassName(userEnv);
  const baseUser = process.env[userEnv] || '';
  const basePass = process.env[passEnv] || '';
  if (!baseUser || !basePass) {
    results.push({
      provider: providerKey(row),
      display_name: row.display_name,
      skipped: true,
      reason: 'missing_env',
      endpoint: { host: row.proxy_host, port: String(row.proxy_port) },
    });
    continue;
  }

  for (let i = 0; i < SAMPLES_PER_PROVIDER; i++) {
    if (submitted && STOP_AFTER_SUBMIT) break;
    const sessId = Math.floor(Math.random() * 9000000 + 1000000);
    const auth = buildStickyAuth(row, baseUser, basePass, sessId, TARGET_CC);
    const proxyUrl = proxyUrlFor(row, auth.username, auth.password);
    const exitIp = sampleExitIp(proxyUrl);
    const geo = exitIp ? await verifyExitCountry(exitIp, TARGET_CC) : { result: 'unknown' };
    const reputation = exitIp ? await verifyExitReputation(exitIp).catch(() => ({ result: 'unknown' })) : { result: 'unknown' };
    const item = {
      provider: providerKey(row),
      display_name: row.display_name,
      endpoint: { host: row.proxy_host, port: String(row.proxy_port) },
      sticky_hash: hash(sessId),
      proxy_user_hash: hash(auth.username),
      exit_ip: exitIp || null,
      exit_ip_hash: hash(exitIp),
      geo,
      reputation,
      browser: null,
      error: null,
    };

    let s;
    try {
      s = await WSession.start({
        label: 'linkedin_rotating_weles_probe',
        proxy: proxyUrl,
        browser: 'chromium',
        os: PROBE_OS,
        headless: true,
        pageDiagnostics: false,
        targetHost: 'https://www.linkedin.com/signup',
        platform: 'linkedin',
      });
      let gotoError = '';
      await s.page.goto('https://www.linkedin.com/signup', { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((e) => { gotoError = String(e?.message ?? e).slice(0, 200); });
      await s.page.waitForTimeout(2500).catch(() => {});
      const summary = await summarizeSignup(s.page);
      const classification = classifySummary(summary);
      item.browser = { ...classification, goto_error: gotoError, summary };
      if (SUBMIT_CANDIDATE && classification.result === 'form' && !submitted) {
        console.log(`[wprobe] submitting form candidate provider=${row.display_name} exit=${exitIp || '?'}`);
        item.submit = await submitSignupCandidate(s);
        submitted = true;
      }
      console.log(`[wprobe] ${row.display_name} sample=${i + 1}/${SAMPLES_PER_PROVIDER} exit=${exitIp || '?'} geo=${geo.result} rep=${reputation.result} browser=${classification.result}${classification.signal ? `:${classification.signal}` : ''}${item.submit ? ` submit=${item.submit.result}` : ''}`);
    } catch (e) {
      item.error = String(e?.message ?? e).slice(0, 300);
      console.log(`[wprobe] ${row.display_name} sample=${i + 1}/${SAMPLES_PER_PROVIDER} exit=${exitIp || '?'} error=${item.error}`);
    } finally {
      await s?.close?.().catch(() => {});
    }
    results.push(item);
  }
}

const formCandidates = results.filter((r) => r.browser?.result === 'form');
const submitAttempts = results.filter((r) => r.submit?.attempted);
const submitResultCounts = submitAttempts.reduce((acc, r) => {
  const key = r.submit?.result || 'unknown';
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});
const summary = {
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  samples_per_provider: SAMPLES_PER_PROVIDER,
  target_country: TARGET_CC,
  probe_os: PROBE_OS,
  submit_candidate: SUBMIT_CANDIDATE,
  stop_after_submit: STOP_AFTER_SUBMIT,
  include: [...INCLUDE],
  provider_count: rows.length,
  sample_count: results.filter((r) => !r.skipped).length,
  form_candidate_count: formCandidates.length,
  submit_attempt_count: submitAttempts.length,
  submit_result_counts: submitResultCounts,
  form_candidates: formCandidates.map((r) => ({
    provider: r.provider,
    display_name: r.display_name,
    endpoint: r.endpoint,
    exit_ip: r.exit_ip,
    geo: r.geo,
    reputation: r.reputation,
    sticky_hash: r.sticky_hash,
  })),
  results,
};

writeFileSync(join(OUT, 'rotating_weles_probe.json'), JSON.stringify(summary, null, 2));
writeFileSync(join(WORK, 'latest.json'), JSON.stringify(summary, null, 2));

if (formCandidates.length) {
  console.log(`PASS: browser form candidates=${formCandidates.length} submit_attempts=${submitAttempts.length}`);
} else {
  console.log('FAIL: no browser form candidates');
  process.exitCode = 2;
}
