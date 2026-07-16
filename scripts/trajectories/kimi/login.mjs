// Kimi Code OAuth login trajectory.
//
// This never opens the operator's browser. `kimi login` runs in an isolated
// HOME with PATH-front open/xdg-open shims and BROWSER pointing at the same
// shim. The shim records the authorize URL; WSession drives that URL in its
// own isolated Chromium profile, then this script waits for Kimi CLI to write
// .kimi-code/credentials/kimi-code.json, validates `kimi -p`, and emits the
// credential JSON on stdout for reauth.mjs to donate.

import { spawn as ptySpawn } from 'node-pty';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WSession } from '../../../dist/session/wsession.js';
import { humanFill, humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';
import { googleSso } from '../_shared/services/google_sso.mjs';
import { establishGoogleSession, waitForEnabledThenClick } from '../codex/google_sso.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const VAR = join(REPO, 'var');
const KIMI_BIN = process.env.KIMI_BIN || 'kimi';
const DISPLAY_NAME = process.env.KIMI_DISPLAY_NAME || 'Kimi';
const SERVICE_CREDENTIAL_ID = process.env.KIMI_SERVICE_CREDENTIAL_ID || 'kimi-lukasz-google-sso';
const LOGIN_HOME = process.env.KIMI_LOGIN_HOME || mkdtempSync(join(tmpdir(), 'kimi-login-'));
const OVERALL_SEC = Number(process.env.KIMI_LOGIN_OVERALL_SEC || 420);

let SESSION = null;
let CHILD = null;

process.on('uncaughtException', (e) => {
  process.stderr.write(`FAIL: uncaught ${e?.stack || e}\n`);
  cleanupAndExit(1);
});
process.on('unhandledRejection', (e) => {
  process.stderr.write(`FAIL: unhandled ${e?.stack || e}\n`);
  cleanupAndExit(1);
});

function cleanupAndExit(code) {
  try { CHILD?.kill(); } catch {}
  Promise.resolve(SESSION?.close?.()).finally(() => process.exit(code));
}

function kimiConfigToml() {
  const local = join(process.env.HOME || '', '.kimi-code', 'config.toml');
  if (existsSync(local)) return readFileSync(local, 'utf8');
  return `default_model = "kimi-code/kimi-for-coding"
default_thinking = true

[providers."managed:kimi-code"]
type = "kimi"
api_key = ""
base_url = "https://api.kimi.com/coding/v1"

[providers."managed:kimi-code".oauth]
storage = "file"
key = "oauth/kimi-code"

[models."kimi-code/kimi-for-coding"]
provider = "managed:kimi-code"
model = "kimi-for-coding"
max_context_size = 262144
capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use" ]
display_name = "K2.7 Code"

[services.moonshot_search]
base_url = "https://api.kimi.com/coding/v1/search"
api_key = ""

[services.moonshot_search.oauth]
storage = "file"
key = "oauth/kimi-code"

[services.moonshot_fetch]
base_url = "https://api.kimi.com/coding/v1/fetch"
api_key = ""

[services.moonshot_fetch.oauth]
storage = "file"
key = "oauth/kimi-code"
`;
}

function prepareKimiHome(home) {
  if (resolve(home) === resolve(process.env.HOME || '')) {
    throw new Error('refusing to run kimi login in the operator HOME');
  }
  mkdirSync(join(home, '.kimi-code', 'credentials'), { recursive: true });
  mkdirSync(join(home, '.kimi-code', 'oauth'), { recursive: true });
  writeFileSync(join(home, '.kimi-code', 'config.toml'), kimiConfigToml(), { mode: 0o600 });
  writeFileSync(join(home, '.kimi-code', 'oauth', 'kimi-code'), '', { mode: 0o600 });
}

function noOpenEnv(home) {
  const dir = join(home, '.noopen');
  const urlFile = join(dir, 'browser-urls.txt');
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, 'browser-shim.sh');
  writeFileSync(shim, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> ${JSON.stringify(urlFile)}\nexit 0\n`, { mode: 0o755 });
  for (const name of ['open', 'xdg-open']) {
    const target = join(dir, name);
    try { rmSync(target); } catch {}
    symlinkSync(shim, target);
  }
  return {
    env: {
      ...process.env,
      HOME: home,
      BROWSER: shim,
      PATH: `${dir}:${process.env.PATH || ''}`,
      KIMI_LOGIN_BROWSER_SHIM: shim,
    },
    urlFile,
  };
}

async function loadLogin() {
  const supabaseUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (!supabaseUrl || !supabaseKey) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  const headers = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };

  const byId = await fetch(
    `${supabaseUrl}/rest/v1/service_credentials?id=eq.${encodeURIComponent(SERVICE_CREDENTIAL_ID)}&select=id,display_name,login_email,login_password,login_method&limit=1`,
    { headers },
  );
  const idRows = byId.ok ? await byId.json() : [];
  let row = idRows[0];

  if (!row) {
    const byName = await fetch(
      `${supabaseUrl}/rest/v1/service_credentials?display_name=ilike.%25${encodeURIComponent(DISPLAY_NAME)}%25&select=id,display_name,login_email,login_password,login_method&limit=1`,
      { headers },
    );
    const rows = byName.ok ? await byName.json() : [];
    row = rows[0];
  }

  if (!row?.login_email) throw new Error(`no Kimi login row (${SERVICE_CREDENTIAL_ID} / ${DISPLAY_NAME})`);
  if (row.login_password) {
    return {
      id: row.id,
      displayName: row.display_name,
      email: row.login_email,
      password: row.login_password,
      loginMethod: row.login_method || 'google_sso',
    };
  }

  const shared = await fetch(
    `${supabaseUrl}/rest/v1/service_credentials?login_email=eq.${encodeURIComponent(row.login_email)}&login_password=not.is.null&select=login_email,login_password&limit=1`,
    { headers },
  );
  const sharedRows = shared.ok ? await shared.json() : [];
  if (!sharedRows[0]?.login_password) throw new Error(`Kimi login row ${row.id} has no password and no shared password row`);
  return {
    id: row.id,
    displayName: row.display_name,
    email: row.login_email,
    password: sharedRows[0].login_password,
    loginMethod: row.login_method || 'google_sso',
  };
}

function spawnKimiLogin(home) {
  const { env, urlFile } = noOpenEnv(home);
  const proc = ptySpawn(KIMI_BIN, ['login', '--json'], {
    name: 'xterm-256color',
    cols: 200,
    rows: 40,
    env,
  });
  CHILD = proc;
  let out = '';
  proc.onData((d) => { out += d; });
  return { proc, getOut: () => out, urlFile };
}

function stripAnsi(s) {
  return String(s || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

function firstLoginUrl(text) {
  const clean = stripAnsi(text);
  for (const line of clean.split(/\r?\n/).reverse()) {
    try {
      const event = JSON.parse(line);
      const url = event?.data?.verification_url;
      if (event?.type === 'verification_url' && typeof url === 'string' && /^https:\/\//.test(url)) {
        return url;
      }
    } catch {}
  }
  const matches = clean.match(/https?:\/\/[^\s"'<>]+/g) || [];
  return matches.find((url) => /kimi|moonshot|accounts\.google\.com|oauth|auth|login/i.test(url)) || null;
}

async function waitForAuthorizeUrl(getOut, urlFile, timeoutSec = 90) {
  for (let i = 0; i < timeoutSec * 2; i += 1) {
    const fromFile = existsSync(urlFile) ? readFileSync(urlFile, 'utf8') : '';
    const url = firstLoginUrl(`${fromFile}\n${getOut()}`);
    if (url) return url;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`kimi login did not expose an authorize URL; out_tail=${JSON.stringify(stripAnsi(getOut()).slice(-800))}`);
}

function credentialsPath(home) {
  return join(home, '.kimi-code', 'credentials', 'kimi-code.json');
}

function readCredentials(home) {
  const path = credentialsPath(home);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw);
    const accessLen = typeof parsed.access_token === 'string' ? parsed.access_token.length : 0;
    const refreshLen = typeof parsed.refresh_token === 'string' ? parsed.refresh_token.length : 0;
    if (accessLen > 32 && refreshLen > 32) return raw;
    return null;
  } catch {
    return null;
  }
}

async function waitForCredentials(home, timeoutSec = 180) {
  for (let i = 0; i < timeoutSec * 2; i += 1) {
    const raw = readCredentials(home);
    if (raw) return raw;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Kimi credentials did not materialize with non-empty OAuth tokens');
}

async function clickEmailRow(page, email) {
  let hit = null;
  for (let i = 0; i < 100; i += 1) {
    hit = await page.evaluate((wanted) => {
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (!txt.includes(wanted)) continue;
        const childMatches = Array.from(el.children || []).some((c) => (c.innerText || c.textContent || '').includes(wanted));
        if (childMatches) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 20) continue;
        let target = el;
        for (let p = el; p; p = p.parentElement) {
          const role = p.getAttribute?.('role');
          if (role === 'button' || role === 'link' || p.tagName === 'A' || p.tagName === 'BUTTON' || p.getAttribute?.('data-identifier')) {
            target = p;
            break;
          }
        }
        const tr = target.getBoundingClientRect();
        return { x: tr.x + tr.width / 2, y: tr.y + tr.height / 2 };
      }
      return null;
    }, email).catch(() => null);
    if (hit) break;
    await page.waitForTimeout(100);
  }
  if (!hit) throw new Error(`no Google account row matching ${email}`);
  await page.mouse.click(Math.round(hit.x), Math.round(hit.y));
}

async function handleGoogleSurface(session, page, login) {
  if (!/accounts\.google\.com/.test(page.url())) return false;
  if (await page.locator('input[type="email"], input[name="identifier"], input#identifierId').filter({ visible: true }).first().isVisible().catch(() => false)) {
    const ok = await googleSso({ page }, { email: login.email, password: login.password }, { originHost: 'kimi.com' });
    if (!ok) throw new Error('Google SSO helper failed on Kimi login');
    return true;
  }
  const text = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
  if (text.includes(login.email)) {
    await clickEmailRow(page, login.email);
    await humanIdlePause('long');
    return true;
  }
  const btn = page.getByRole('button', { name: /^(continue|allow|next|dalej)$/i }).filter({ visible: true }).first();
  if (await btn.isVisible().catch(() => false)) {
    await humanClickLocator(page, btn);
    await humanIdlePause('long');
    return true;
  }
  return false;
}

async function driveKimiAuthorize(authorizeUrl, login, home) {
  const s = await WSession.start({
    label: 'kimi_login',
    browser: 'chromium',
    proxy: process.env.KIMI_LOGIN_PROXY === 'none' ? undefined : (process.env.KIMI_LOGIN_PROXY || undefined),
    headless: process.env.KIMI_LOGIN_HEADLESS === '1',
  });
  SESSION = s;

  let popup = null;
  const onPage = (p) => { if (!popup) popup = p; };
  s.page.context().on('page', onPage);
  try {
    if ((login.loginMethod || '').includes('google')) {
      await establishGoogleSession({
        page: s.page,
        login,
        mark: (m) => process.stderr.write(`[kimi login] ${m}\n`),
        humanFill,
        humanClickLocator,
        humanIdlePause,
        humanType,
      });
    }

    await s.page.goto(authorizeUrl, { waitUntil: 'commit' });
    await humanIdlePause('deliberate');

    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      if (readCredentials(home)) return;

      const targets = [s.page];
      if (popup && !popup.isClosed()) targets.push(popup);
      for (const page of targets) {
        if (readCredentials(home)) return;
        const url = page.url();
        if (/accounts\.google\.com/.test(url)) {
          await handleGoogleSurface(s, page, login);
          continue;
        }
        const googleBtn = page.locator('.google-login-btn, button, [role="button"], a')
          .filter({ hasText: /google|continue with google|sign in with google|log in with google/i })
          .filter({ visible: true })
          .first();
        if (await googleBtn.isVisible().catch(() => false)) {
          await humanClickLocator(page, googleBtn);
          await humanIdlePause('long');
          continue;
        }
        const continueBtn = page.getByRole('button', { name: /^(continue|allow|authorize|confirm|next|dalej)$/i })
          .filter({ visible: true })
          .first();
        if (await continueBtn.isVisible().catch(() => false)) {
          await humanClickLocator(page, continueBtn);
          await humanIdlePause('long');
          continue;
        }
      }
      await s.page.waitForTimeout(500);
    }
    throw new Error(`Kimi browser authorization did not complete; url=${s.page.url()}`);
  } finally {
    s.page.context().off('page', onPage);
  }
}

function verifyKimiCredential(home) {
  const res = spawnSync(KIMI_BIN, ['-p', 'Reply with exactly OK.', '--output-format', 'stream-json'], {
    cwd: home,
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
    timeout: 60_000,
  });
  if (res.status !== 0) {
    throw new Error(`kimi credential verification failed status=${res.status} stderr=${String(res.stderr || '').slice(0, 800)} stdout=${String(res.stdout || '').slice(0, 800)}`);
  }
  if (!/OK/i.test(`${res.stdout}\n${res.stderr}`)) {
    throw new Error(`kimi credential verification returned unexpected output: ${String(res.stdout || '').slice(0, 800)}`);
  }
}

const killer = setTimeout(() => {
  process.stderr.write(`FAIL: Kimi login overall timeout ${OVERALL_SEC}s\n`);
  cleanupAndExit(1);
}, OVERALL_SEC * 1000);

try {
  mkdirSync(VAR, { recursive: true });
  prepareKimiHome(LOGIN_HOME);
  const login = await loadLogin();
  process.stderr.write(`[kimi login] starting for ${login.email} using isolated HOME=${LOGIN_HOME}\n`);

  const { proc, getOut, urlFile } = spawnKimiLogin(LOGIN_HOME);
  const authorizeUrl = await waitForAuthorizeUrl(getOut, urlFile);
  process.stderr.write(`[kimi login] authorize URL captured host=${new URL(authorizeUrl).host}\n`);

  await driveKimiAuthorize(authorizeUrl, login, LOGIN_HOME);
  const creds = await waitForCredentials(LOGIN_HOME);
  verifyKimiCredential(LOGIN_HOME);

  clearTimeout(killer);
  try { proc.kill(); } catch {}
  await SESSION?.close?.();
  process.stdout.write(`\n__KIMI_CREDENTIALS_JSON_B64__${Buffer.from(creds, 'utf8').toString('base64')}\n`);
  process.stderr.write('[kimi login] credentials emitted after verification\n');
  process.exit(0);
} catch (e) {
  clearTimeout(killer);
  process.stderr.write(`FAIL: ${e?.stack || e}\n`);
  try {
    const p = join(VAR, 'kimi-login-home-last.txt');
    writeFileSync(p, `${LOGIN_HOME}\n`);
  } catch {}
  cleanupAndExit(1);
}
