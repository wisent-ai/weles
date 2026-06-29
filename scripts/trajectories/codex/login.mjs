// Codex OAuth login trajectory — drives `codex login --device-auth` headlessly.
//
// Flow:
//   1. Read credentials from service_credentials (display_name='Codex' or env
//      CODEX_DISPLAY_NAME). Supports login_method='email_password' or
//      'google_sso'.
//   2. Spawn `codex login --device-auth` in a PTY.
//   3. Parse the device-auth URL and one-time code from stdout.
//   4. Use WSession to open the URL, enter the code, and complete login.
//   5. Wait for `codex login` to write ~/.codex/auth.json, then emit the JSON
//      blob on stdout for reauth.mjs to donate.

import { spawn as ptySpawn } from 'node-pty';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getServiceLogin } from '../../../dist/utils/credentials.js';
import { WSession } from '../../../dist/session/wsession.js';
import { doGoogleSso } from './google_sso.mjs';
import { humanFill, humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../dist/human/mouse.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CODEX_AUTH_PATH = join(homedir(), '.codex', 'auth.json');
const DISPLAY_NAME = process.env.CODEX_DISPLAY_NAME || 'Codex';
const CODEX_BIN = process.env.CODEX_BIN || 'codex';

// Keep all console channels real during trajectory debugging; WSession step logs
// and Playwright errors are essential for diagnosing login failures.

process.on('uncaughtException', (e) => { process.stderr.write(`FAIL: uncaught ${e?.stack || e}\n`); process.exit(1); });
process.on('unhandledRejection', (e) => { process.stderr.write(`FAIL: unhandled ${e?.stack || e}\n`); process.exit(1); });

async function readAuthJson() {
  if (!existsSync(CODEX_AUTH_PATH)) return null;
  try { return readFileSync(CODEX_AUTH_PATH, 'utf8'); } catch { return null; }
}

function spawnDeviceAuth() {
  // Use the local-callback flow (no --device-auth). This starts an HTTP
  // server on localhost and gives us an OAuth authorize URL. The browser
  // only has to complete the OAuth handoff; Codex CLI receives the token
  // via the local callback, so there is no dependency on ChatGPT's
  // "device code authorization" switch.
  const proc = ptySpawn(CODEX_BIN, ['login'], {
    name: 'xterm-256color',
    cols: 200,
    rows: 40,
    env: process.env,
  });
  let buf = '';
  proc.onData((d) => { buf += d; });
  return { proc, getOut: () => buf };
}

async function waitForDeviceCode(getOut, timeoutSec = 60) {
  for (let i = 0; i < timeoutSec * 2; i += 1) {
    const out = getOut();
    if (i % 4 === 0) {
      process.stderr.write(`[codex login] poll ${i} out_len=${out.length} tail=${JSON.stringify(out.slice(-120))}\n`);
    }
    // Strip ANSI sequences before matching; escape codes break word-boundary regexes.
    const clean = out.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    const urlMatch = clean.match(/https:\/\/auth\.openai\.com\/oauth\/authorize\?[^\s]+/);
    if (urlMatch) {
      return { url: urlMatch[0], code: null };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('OAuth authorize URL not emitted by codex login');
}

async function waitForAuthJson(prevAuth, timeoutSec = 120) {
  for (let i = 0; i < timeoutSec * 2; i += 1) {
    const cur = await readAuthJson();
    if (cur && cur !== prevAuth) return cur;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('~/.codex/auth.json did not update after login');
}

async function fillAndVerify(page, locator, text) {
  const { humanClickLocator } = await import('../../../dist/human/mouse.js');
  const { humanType } = await import('../../../dist/human/keyboard.js');
  await locator.waitFor({ state: 'visible' });
  for (let i = 0; i < 50; i += 1) {
    if (await locator.isEditable()) break;
    await page.waitForTimeout(100);
  }
  await humanClickLocator(page, locator);
  await humanType(page, text);
  for (let i = 0; i < 20; i += 1) {
    const v = await locator.inputValue();
    if (v === text) return;
    await page.waitForTimeout(100);
  }
  throw new Error('fillAndVerify: value did not land');
}

async function waitForEnabledThenClick(page, pattern, maxSec = 20) {
  const { humanClick } = await import('../../../dist/human/mouse.js');
  for (let i = 0; i < maxSec * 10; i += 1) {
    const state = await page.evaluate((src) => {
      const re = new RegExp(src, 'i');
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'));
      for (const el of candidates) {
        const txt = (el.innerText || el.textContent || '').trim();
        if (!re.test(txt)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true' || el.getAttribute('disabled') !== null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled, found: true };
      }
      return { found: false };
    }, pattern.source);
    if (state.found && !state.disabled) {
      await humanClick(page, Math.round(state.x), Math.round(state.y));
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`waitForEnabledThenClick: no clickable element for /${pattern.source}/i`);
}

async function completeOpenAiConsent(session) {
  // OpenAI / ChatGPT device-code consent page shows "Continue" after GIS
  // authentication. Click it so the CLI can receive the callback token.
  for (let i = 0; i < 60; i += 1) {
    const url = session.page.url();
    const onTerminal = /(platform\.openai\.com|chatgpt\.com)/i.test(url);
    const onAuth = /auth\.openai\.com/i.test(url);
    if (onTerminal) {
      const btn = session.page.locator('button:has-text("Continue"), button:has-text("Authorize"), button:has-text("Allow"), button:has-text("Confirm"), button:has-text("Dalej")').filter({ visible: true }).first();
      if (await btn.count() > 0) {
        try {
          await btn.click();
          await session.wait(2);
          return;
        } catch (e) {
          if (!e.message?.includes('detached')) throw e;
        }
      }
      // Already on the terminal host; the CLI may just need more time.
      if (i > 5) return;
    }
    if (onAuth) {
      // auth.openai.com is a login/redirect page; never click its Continue.
      return;
    }
    await session.wait(1);
  }
}

async function doOpenAiLogin(session, login) {
  // OpenAI device-auth URL lands on the login page. The device code is bound
  // to the browser session by the OAuth backend; we just need to authenticate
  // and authorize Codex. The login page offers Google/Apple/Email options.
  if (login.loginMethod === 'google_sso') {
    // Establish a Google session FIRST in the same tab, then reload the device
    // URL and click Continue-with-Google. GIS sees the session and either
    // silently authorizes or shows an in-page account chooser / popup.
    await doGoogleSso({
      page: session.page,
      login,
      authorizeUrl: login.url,
      mark: (label) => process.stderr.write(`[google_sso] ${label}\n`),
      humanFill,
      humanClickLocator,
      humanIdlePause,
      humanType,
    });
  } else {
    const emailInput = session.page.locator('input[type="email"], input[name="username"], input[name="email"], input[autocomplete="username"]').filter({ visible: true }).first();
    if (await emailInput.count() > 0) {
      await session.fill('input[type="email"]', login.email);
      await session.press('Enter');
      await session.wait(2);
    }
    const passInput = session.page.locator('input[type="password"]').filter({ visible: true }).first();
    if (await passInput.count() > 0) {
      await session.fill('input[type="password"]', login.password);
      await session.press('Enter');
      await session.wait(4);
    }
    const otpInput = session.page.locator('input[type="tel"], input[autocomplete="one-time-code"]').filter({ visible: true }).first();
    if (await otpInput.count() > 0 && await otpInput.isVisible().catch(() => false)) {
      const otp = process.env.CODEX_2FA_CODE;
      if (!otp) throw new Error('OpenAI 2FA prompt visible but CODEX_2FA_CODE env not set');
      await session.fill('input[autocomplete="one-time-code"]', otp);
      await session.press('Enter');
      await session.wait(4);
    }
  }

  await completeOpenAiConsent(session);
}

const login = await getServiceLogin(DISPLAY_NAME);
if (!login) { process.stderr.write(`FAIL: no '${DISPLAY_NAME}' row in service_credentials\n`); process.exit(1); }
if (!login.email || !login.password) {
  process.stderr.write(`FAIL: '${DISPLAY_NAME}' missing email/password\n`);
  process.exit(1);
}

const priorAuth = await readAuthJson();
process.stderr.write(`[codex login] starting device-auth for ${login.email} (method=${login.loginMethod})\n`);

const { proc, getOut } = spawnDeviceAuth();
let session;
let deviceCode;
try {
  const { url, code } = await waitForDeviceCode(getOut);
  deviceCode = code;
  process.stderr.write(`[codex login] device URL=${url} code=${code}\n`);

  login.url = url;
  login.code = code;
  session = await WSession.start({ label: 'codex_login', headless: false, browser: 'chromium' });
  await session.goto(url);
  await doOpenAiLogin(session, login);

  // Wait for auth.json to be written/updated.
  const authJson = await waitForAuthJson(priorAuth);
  process.stdout.write(authJson);
  process.stderr.write('[codex login] auth.json emitted\n');
} catch (e) {
  if (e?.code === 'CODEX_DEVICE_AUTH_DISABLED') {
    process.stderr.write(`FAIL: ${e.message}\nTo fix this, enable "Device code authorization for Codex" in ChatGPT Security Settings (https://chatgpt.com/#settings/security) while signed in as ${login.email}.\n`);
  } else {
    process.stderr.write(`FAIL: ${e?.stack || e}\n`);
  }
  try {
    const out = getOut();
    process.stderr.write(`[codex login] process output:\n${out}\n`);
  } catch {}
  process.exitCode = 1;
} finally {
  try { proc.kill('SIGKILL'); } catch {}
  try { await session?.close(); } catch {}
}
