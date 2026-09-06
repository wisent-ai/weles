// Google Authenticator activation through the persistent Weles keeper.
// No CUA. No CDP attach. No short-lived WSession loop. The keeper owns the browser/profile.

import net from 'node:net';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generateTotp } from '../../_shared/services/google_sso.mjs';
import { assertScopedSecretWriter, readScopedLogin, writeScopedLogin } from '../../../_shared/scoped-secrets.mjs';

const GOOGLE_ADS_LOGIN = readScopedLogin('googleAds');
const REPO = process.env.WELES_REPO || resolve(process.cwd(), '..', 'weles');
const SESSION = process.env.SESSION || process.env.GOOGLE_ADS_KEEPER_SESSION || 'google_ads';
const EMAIL = GOOGLE_ADS_LOGIN.email;
const USER_DATA_DIR = process.env.WELES_USER_DATA_DIR || process.env.ADS_PROFILE_DIR || join(homedir(), '.weles', 'browser_profiles', 'google_ads');
const KEEPER = join(REPO, 'scripts', '_shared', 'keeper', 'keeper.mjs');
const SOCK = join(homedir(), '.weles', 'keeper', SESSION, 'socket');
const DIAG_DIR = process.env.GOOGLE_TOTP_KEEPER_DIAG_DIR || '.work/google-totp-keeper';
const RESULT_FILE = process.env.GOOGLE_TOTP_KEEPER_RESULT_FILE || join(DIAG_DIR, 'result.json');
const AUTHENTICATOR_URL = 'https://myaccount.google.com/u/1/two-step-verification/authenticator';
const SECURITY_URL = 'https://myaccount.google.com/u/1/security';

mkdirSync(DIAG_DIR, { recursive: true });

function scopedChildEnvironment(overrides) {
  const env = { ...process.env, ...overrides };
  const exactAmbientKeys = [
    'GOOGLE_ADS_EMAIL',
    'GOOGLE_PASSWORD',
    'GOOGLE_TOTP_SECRET',
    'GOOGLE_AUTHENTICATOR_SECRET',
    'GOOGLE_SSO_MANUAL_TOTP_CODE',
    'GOOGLE_SSO_MANUAL_TOTP',
    'GOOGLE_SSO_MANUAL_TOTP_FILE',
    'GOOGLE_SSO_MANUAL_TOTP_READY_FILE',
    'GOOGLE_TOTP_CODE',
    'SSO_EMAIL',
    'SSO_PASS',
    'SSO_PASSWORD',
    'SSO_TOTP_SECRET',
    'GM_EMAIL',
    'GM_PASSWORD',
    'GM_TOTP_SECRET',
    'BRIGHTDATA_ZONE',
    'BRIGHTDATA_BROWSER_WS',
  ];
  for (const key of exactAmbientKeys) delete env[key];
  for (const key of Object.keys(env)) {
    if (/^(?:OXYLABS|BRIGHTDATA)_(?:.*(?:USERNAME|PASSWORD|USER|PASS))$/.test(key)) delete env[key];
  }
  return env;
}

function redact(text, secret = '') {
  const escaped = secret ? String(secret).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  let out = String(text || '');
  if (escaped) out = out.replace(new RegExp(escaped, 'gi'), '<redacted-totp-secret>');
  return out
    .replace(/[A-Z2-7](?:\s?[A-Z2-7]){15,}/g, '<redacted-base32-secret>')
    .replace(/"login_password"\s*:\s*"[^"]+"/g, '"login_password":"<redacted>"')
    .replace(/"google_totp_secret"\s*:\s*"[^"]+"/g, '"google_totp_secret":"<redacted>"');
}

function writeResult(report, code = 0, secret = '') {
  const safe = JSON.parse(redact(JSON.stringify(report), secret));
  writeFileSync(RESULT_FILE, JSON.stringify(safe, null, 2));
  console.log(JSON.stringify(safe, null, 2));
  process.exit(code);
}

function socketReady() {
  return existsSync(SOCK);
}

function action(cmd, timeoutMs = 60_000) {
  return new Promise((resolvePromise, reject) => {
    const conn = net.createConnection(SOCK);
    let done = false;
    let buf = '';
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { conn.destroy(); } catch {}
      reject(new Error(`keeper action timeout: ${cmd.action}`));
    }, timeoutMs);
    conn.on('connect', () => conn.write(`${JSON.stringify(cmd)}\n`));
    conn.on('data', (chunk) => {
      buf += chunk.toString();
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      if (done) return;
      done = true;
      clearTimeout(timer);
      conn.end();
      try {
        const parsed = JSON.parse(buf.slice(0, nl));
        if (!parsed.ok) reject(new Error(parsed.error || `keeper action failed: ${cmd.action}`));
        else resolvePromise(parsed);
      } catch (error) {
        reject(error);
      }
    });
    conn.on('error', (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function waitForKeeper(ms = 90_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (socketReady()) {
      try { await action({ action: 'url' }, 5_000); return true; } catch {}
    }
    await sleep(500);
  }
  return false;
}

function startKeeperIfNeeded() {
  if (socketReady()) return false;
  if (process.env.GOOGLE_ADS_KEEPER_START === '0') return false;
  mkdirSync(dirname(SOCK), { recursive: true });
  const logPath = join(DIAG_DIR, `keeper-${SESSION}.log`);
  const fd = openSync(logPath, 'a');
  const child = spawn(process.execPath, [KEEPER], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: scopedChildEnvironment({
      SESSION,
      KEEPER_FLOW_ACTION: 'google_ads_totp_keeper',
      KEEPER_USER_DATA_DIR: USER_DATA_DIR,
      WELES_USER_DATA_DIR: USER_DATA_DIR,
      KEEPER_STAY_ALIVE_ON_SIGTERM: '1',
      KEEPER_DISABLE_WEBAUTHN: '1',
      WELES_DISABLE_RECORDING: process.env.WELES_DISABLE_RECORDING || '1',
      WELES_NO_INSTRUMENT: process.env.WELES_NO_INSTRUMENT || '1',
      GOOGLE_SSO_NO_SCREENSHOTS: '1',
      URL: AUTHENTICATOR_URL,
    }),
  });
  child.unref();
  return true;
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function state() {
  const res = await action({
    action: 'eval',
    js: `(() => ({
      url: location.href,
      title: document.title,
      text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 7000),
      inputs: Array.from(document.querySelectorAll('input')).map((el) => ({
        type: el.getAttribute('type') || '',
        name: el.getAttribute('name') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        placeholder: el.getAttribute('placeholder') || '',
        aria: el.getAttribute('aria-label') || '',
        visible: Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
        valueLength: String(el.value || '').length,
      })).slice(0, 40),
      controls: Array.from(document.querySelectorAll('button, [role="button"], a, [role="link"], li, div[role="option"]')).map((el) => ({
        tag: (el.tagName || '').toLowerCase(),
        role: el.getAttribute('role') || '',
        text: (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 240),
        href: el.href || '',
        aria: el.getAttribute('aria-label') || '',
      })).filter((item) => item.text || item.href || item.aria).slice(0, 120),
    }))()`,
  });
  return res.result || { url: '', text: '', controls: [], inputs: [] };
}

async function idle(kind = 'deliberate') {
  await action({ action: 'humanidle', kind }, 30_000).catch(() => {});
}

async function nav(url) {
  await action({ action: 'nav', url }, 120_000);
  await idle('deliberate');
}

function selectorForText(text) {
  const escaped = String(text).replace(/"/g, '\\"');
  return `button:has-text("${escaped}"), [role="button"]:has-text("${escaped}"), a:has-text("${escaped}"), [role="link"]:has-text("${escaped}"), li:has-text("${escaped}"), div[role="option"]:has-text("${escaped}")`;
}

async function clickText(values) {
  const list = Array.isArray(values) ? values : [values];
  let last = null;
  for (const value of list) {
    try {
      await action({ action: 'click', selector: selectorForText(value) }, 30_000);
      await idle('deliberate');
      return value;
    } catch (error) {
      last = error;
    }
    const needle = JSON.stringify(String(value).toLowerCase());
    const hit = await action({
      action: 'eval',
      js: `(() => {
        const needle = ${needle};
        const norm = (v) => String(v || '').replace(/\\s+/g, ' ').trim().toLowerCase();
        const visible = (el) => {
          const r = el.getBoundingClientRect?.();
          if (!r || r.width < 2 || r.height < 2) return false;
          const st = getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity || '1') !== 0;
        };
        const nodes = Array.from(document.querySelectorAll('button, [role="button"], a, [role="link"], li, div[role="option"]'));
        return nodes.map((el) => {
          if (!visible(el)) return null;
          const text = norm(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
          if (!text.includes(needle)) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, area: r.width * r.height };
        }).filter(Boolean).sort((a, b) => a.area - b.area)[0] || null;
      })()`,
    }, 10_000).catch(() => null);
    if (hit?.result) {
      await action({ action: 'humanclick', x: hit.result.x, y: hit.result.y }, 30_000);
      await idle('deliberate');
      return value;
    }
  }
  throw last || new Error(`clickText failed: ${list.join(', ')}`);
}

async function fill(selector, text) {
  await action({ action: 'fill_fast', selector, text }, 30_000)
    .catch(() => action({ action: 'set_value', selector, text }, 30_000));
  await idle('short');
}

async function press(key) {
  await action({ action: 'press', key }, 30_000);
  await idle('deliberate');
}
async function navigateStoredTotpChallenge(currentUrl) {
  if (!/accounts\.google\.com/.test(currentUrl || '') || !/signin\/challenge\/selection/.test(currentUrl || '')) return false;
  if (process.env.GOOGLE_SSO_ALLOW_DIRECT_TOTP !== '1') return false;
  const target = currentUrl.replace(/\/signin\/challenge\/selection(?=[?#])/, '/signin/challenge/totp');
  if (target === currentUrl) return false;
  const attempts = navigateStoredTotpChallenge.attempts || (navigateStoredTotpChallenge.attempts = new Set());
  const key = currentUrl.replace(/([?&](?:TL|rart|dsh)=)[^&]+/g, '$1');
  if (attempts.has(key)) return false;
  attempts.add(key);
  console.log('[google-ads-totp-keeper] opening Google Authenticator TOTP challenge directly');
  await nav(target);
  const next = await state();
  if (next.inputs.some((input) => input.visible && /totpPin|Pin|one-time-code|numeric|tel/i.test(`${input.name} ${input.autocomplete} ${input.type}`))) return true;
  await nav(currentUrl);
  return false;
}



async function submitStoredGoogleCode(creds, offsetMs = 0) {
  if (!creds?.totpSecret) return false;
  const code = generateTotp(creds.totpSecret, offsetMs ? { now: Date.now() + offsetMs } : {});
  await fill('input[type="tel"], input[type="text"], input[inputmode="numeric"], input[name="totpPin"], input[name="Pin"]', code);
  await clickText(['Next', 'Verify', 'Done']).catch(async () => press('Enter'));
  return true;
}

async function handleGoogleLogin(creds) {
  for (let step = 0; step < 40; step += 1) {
    const s = await state();
    const text = s.text || '';
    const url = s.url || '';
    if (!/accounts\.google\.com/.test(url)) return true;
    if (/session ended|not signed in|Try signing in again|Try again/i.test(text)) {
      await clickText('Try again').catch(() => {});
      await idle('deliberate');
      continue;
    }

    if (/Email or phone|Sign in|Use your Google Account/i.test(text) && s.inputs.some((input) => /email|identifier/i.test(`${input.type} ${input.name} ${input.aria}`) && input.visible)) {
      await fill('input[type="email"], input[name="identifier"], input#identifierId', creds.email || EMAIL);
      await clickText('Next').catch(async () => press('Enter'));
      continue;
    }

    if (/Enter your password|password/i.test(text) && s.inputs.some((input) => /password|Passwd/i.test(`${input.type} ${input.name}`) && input.visible)) {
      await fill('input[type="password"], input[name="Passwd"]', creds.password);
      await press('Enter');
      continue;
    }

    if (/Tap Yes on your phone|Gmail app|Try another way|More ways to verify|Choose how you want to sign in/i.test(text) && !/Enter code|verification code from the Google Authenticator app/i.test(text)) {
      let after = s;
      if (/Try another way|More ways to verify/i.test(text)) {
        await clickText(['Try another way', 'More ways to verify']).catch(() => {});
        await idle('deliberate');
        after = await state();
      }
      if (/Tap Yes on your phone|Gmail app|phone or tablet/i.test(after.text || '') && !/Try another way|More ways to verify/i.test(after.text || '')) {
        await clickText(['Tap Yes on your phone or tablet', 'Gmail app', 'phone or tablet']).catch(() => {});
        await idle('deliberate');
        continue;
      }
      if (/Get a verification code from the Google Authenticator app|Google Authenticator app|Authenticator/i.test(after.text || '')) {
        await clickText(['Get a verification code from the Google Authenticator app', 'Google Authenticator app', 'Authenticator']).catch(() => {});
        await idle('deliberate');
        if (await submitStoredGoogleCode(creds)) continue;
      }
      if (creds?.totpSecret && await navigateStoredTotpChallenge(after.url || url)) {
        if (await submitStoredGoogleCode(creds)) continue;
      }
      continue;
    }

    if (/Get a verification code from the Google Authenticator app|Enter code|verification code/i.test(text)) {
      if (!await submitStoredGoogleCode(creds)) return false;
      continue;
    }

    if (/Wrong code|Try again/i.test(text)) {
      if (!await submitStoredGoogleCode(creds, Number('31000'))) return false;
      continue;
    }

    await idle('short');
  }
  return false;
}

function extractSetupSecret(text) {
  const compact = String(text || '').replace(/\s+/g, ' ');
  const labeled = compact.match(/(?:setup key|secret key|key)\D{0,80}([A-Z2-7](?:\s?[A-Z2-7]){15,})/i);
  if (labeled) return labeled[1].toUpperCase().replace(/[^A-Z2-7]/g, '');
  const candidate = compact.match(/\b[A-Z2-7](?:\s?[A-Z2-7]){23,}\b/i);
  return candidate ? candidate[0].toUpperCase().replace(/[^A-Z2-7]/g, '') : '';
}


async function openAuthenticatorSettings(creds) {
  await nav(AUTHENTICATOR_URL);
  if (/accounts\.google\.com/.test((await state()).url || '')) {
    if (!await handleGoogleLogin(creds)) return false;
    await nav(AUTHENTICATOR_URL);
  }
  const s = await state();
  if (/security/i.test(s.url || '') && !/Authenticator app|2-Step Verification|Change authenticator/i.test(s.text || '')) {
    await nav(SECURITY_URL);
    await clickText(['2-Step Verification', '2-step verification']).catch(() => {});
  }
  return true;
}

async function activateSetup(creds) {
  const steps = [];
  if (!await openAuthenticatorSettings(creds)) return { ok: false, blocked: 'google_login_failed_or_manual_code_timeout', steps };

  for (let i = 0; i < 30; i += 1) {
    const s = await state();
    const text = s.text || '';
    steps.push({ i, url: s.url, textPreview: redact(text).slice(0, 500) });

    if (/accounts\.google\.com/.test(s.url || '')) {
      if (!await handleGoogleLogin(creds)) return { ok: false, blocked: 'google_reauth_failed_or_manual_code_timeout', steps };
      continue;
    }

    if (/Remove anyway/i.test(text)) {
      await clickText('Cancel').catch(() => {});
      continue;
    }

    if (/Change authenticator app/i.test(text)) {
      await clickText('Change authenticator app');
      continue;
    }

    if (/Set up authenticator|Add authenticator|Authenticator app/i.test(text) && !/Enter code|verification code/i.test(text)) {
      await clickText(['Set up authenticator', 'Add authenticator', 'Authenticator app', 'Get started']).catch(() => {});
      continue;
    }

    if (/QR code|scan|setup key|secret key|Can.?t scan/i.test(text) && !/Enter code|verification code/i.test(text)) {
      if (!/setup key|secret key/i.test(text)) await clickText(["Can't scan it", 'setup key', 'Enter a setup key']).catch(() => {});
      await idle('deliberate');
      const withKey = await state();
      const setupSecret = extractSetupSecret(withKey.text || '');
      if (!setupSecret) return { ok: false, blocked: 'google_setup_key_not_found', steps };
      await clickText(['Next', 'Continue']).catch(() => {});
      await idle('deliberate');
      const code = generateTotp(setupSecret);
      await fill('input[name="totpPin"], input[name="Pin"], input[type="tel"], input[type="text"], input[inputmode="numeric"]', code);
      await clickText(['Verify', 'Next', 'Done']).catch(async () => press('Enter'));
      await idle('deliberate');
      const after = await state();
      if (/Wrong code|Try again|Invalid code|Couldn.?t verify/i.test(after.text || '')) {
        const retry = generateTotp(setupSecret, { now: Date.now() + 31_000 });
        await fill('input[name="totpPin"], input[name="Pin"], input[type="tel"], input[type="text"], input[inputmode="numeric"]', retry);
        await clickText(['Verify', 'Next', 'Done']).catch(async () => press('Enter'));
        await idle('deliberate');
      }
      const finalState = await state();
      if (/Wrong code|Try again|Invalid code|Couldn.?t verify/i.test(finalState.text || '')) return { ok: false, blocked: 'new_google_totp_code_rejected', steps };
      writeScopedLogin('googleAds', {
        email: creds.email,
        password: creds.password,
        totpSecret: setupSecret,
      });
      return { ok: true, activated: true, stored: true, url: finalState.url, steps };
    }

    if (/Enter code|verification code/i.test(text)) {
      const setupSecret = extractSetupSecret(text);
      if (setupSecret) {
        const code = generateTotp(setupSecret);
        await fill('input[name="totpPin"], input[name="Pin"], input[type="tel"], input[type="text"], input[inputmode="numeric"]', code);
        await clickText(['Verify', 'Next', 'Done']).catch(async () => press('Enter'));
        continue;
      }
      return { ok: false, blocked: 'code_input_without_setup_key', steps };
    }

    await idle('short');
  }

  return { ok: false, blocked: 'authenticator_activation_state_not_reached', steps };
}

async function main() {

  const creds = GOOGLE_ADS_LOGIN;
  if (!creds?.password || !creds?.totpSecret) {
    writeResult({ ok: false, blocked: 'missing_google_ads_password_or_totp_secret', email: EMAIL }, Number('2'));
  }
  assertScopedSecretWriter('googleAds');

  const started = startKeeperIfNeeded();
  if (!await waitForKeeper()) writeResult({ ok: false, blocked: 'keeper_not_ready', session: SESSION, socket: SOCK, started }, 3);

  const report = await activateSetup({ ...creds, email: EMAIL });
  report.session = SESSION;
  report.profile = USER_DATA_DIR;
  report.resultFile = RESULT_FILE;
  writeResult(report, report.ok ? 0 : 4);
}

main().catch((error) => {
  writeResult({ ok: false, blocked: 'google_totp_keeper_error', error: String(error?.message || error) }, 1);
});
