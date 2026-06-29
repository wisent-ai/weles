import { existsSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_APPLE_2FA_CODE_FILE = '/tmp/weles_apple_2fa_code.txt';
export const DEFAULT_APPLE_2FA_WAIT_MS = 120000;

export function appleNativeTwoFactorHelperPath() {
  return process.env.APPLE_2FA_AX_CAPTURE_SCRIPT || join(here, 'followup_ax_capture.swift');
}

function codeFilePath(path = process.env.APPLE_2FA_CODE_FILE) {
  return path || DEFAULT_APPLE_2FA_CODE_FILE;
}

function readCapturedCode(path) {
  if (!existsSync(path)) return null;
  const code = readFileSync(path, 'utf8').replace(/\D/g, '').slice(0, 6);
  return /^\d{6}$/.test(code) ? code : null;
}

function publicCaptureResult(result, codeFile) {
  const json = result && typeof result === 'object' ? result : {};
  return {
    ...json,
    code: undefined,
    outputFile: json.outputFile || (json.codeCaptured ? codeFile : null),
  };
}

export function captureAppleNativeTwoFactor(options = {}) {
  const codeFile = codeFilePath(options.codeFile);
  const helperPath = options.helperPath || appleNativeTwoFactorHelperPath();
  const args = [];
  if (options.clickAllow) args.push('--click-allow');
  if (options.clickDone) args.push('--click-done');
  if (options.pid) args.push('--pid', String(options.pid));

  if (!existsSync(helperPath)) {
    return {
      ok: false,
      accessibilityTrusted: false,
      codeCaptured: false,
      clicked: [],
      outputFile: null,
      error: `missing Apple native 2FA helper: ${helperPath}`,
    };
  }

  const result = spawnSync('/usr/bin/swift', [helperPath, ...args], {
    cwd: options.cwd || process.cwd(),
    env: { ...process.env, ...(options.env || {}), APPLE_2FA_CODE_FILE: codeFile },
    encoding: 'utf8',
    timeout: options.timeoutMs || 30000,
  });

  if (result.status !== 0) {
    return {
      ok: false,
      accessibilityTrusted: false,
      codeCaptured: false,
      clicked: [],
      outputFile: null,
      error: (result.stderr || result.stdout || `swift exited ${result.status}`).slice(0, 1000),
    };
  }

  try {
    return publicCaptureResult(JSON.parse(result.stdout || '{}'), codeFile);
  } catch (error) {
    return {
      ok: false,
      accessibilityTrusted: false,
      codeCaptured: false,
      clicked: [],
      outputFile: null,
      error: `invalid Apple native 2FA helper JSON: ${error.message}`,
    };
  }
}

function logCapture(logPrefix, capture) {
  if (!logPrefix || (!capture.clicked?.length && !capture.codeCaptured && capture.ok !== false)) return;
  const summary = capture.ok === false
    ? { ok: false, error: String(capture.error || '').slice(0, 240) }
    : { clicked: capture.clicked || [], codeCaptured: Boolean(capture.codeCaptured) };
  console.log(`${logPrefix} native 2FA ${JSON.stringify(summary)}`);
}

async function waitOneSecond(session) {
  if (session?.wait) {
    await session.wait(1);
  } else {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

export async function waitForAppleNativeTwoFactorCode(session, options = {}) {
  const envCode = process.env.APPLE_2FA_CODE;
  if (/^\d{6}$/.test(envCode || '')) {
    return { ok: true, code: envCode, source: 'env', codeFile: null, capture: null };
  }

  const codeFile = codeFilePath(options.codeFile);
  if (options.clearCodeFile !== false) rmSync(codeFile, { force: true });

  const deadline = Date.now() + Number(options.waitMs || process.env.APPLE_2FA_WAIT_MS || DEFAULT_APPLE_2FA_WAIT_MS);
  let lastCapture = null;
  while (Date.now() < deadline) {
    lastCapture = captureAppleNativeTwoFactor({
      ...options,
      codeFile,
      clickAllow: options.clickAllow !== false,
      clickDone: options.clickDone !== false,
    });
    logCapture(options.logPrefix, lastCapture);

    const code = readCapturedCode(codeFile);
    if (code) {
      return { ok: true, code, source: 'native_followup_ax', codeFile, capture: lastCapture };
    }
    await waitOneSecond(session);
  }

  return { ok: false, code: null, source: null, codeFile, capture: lastCapture };
}

export async function fillAppleTwoFactorCode(scope, page, code) {
  const inputs = await scope.locator([
    'input[aria-label*="digit"]',
    'input[aria-label*="Digit"]',
    'input[id*="char"]',
    'input[type="tel"][maxlength="1"]',
    'input[type="tel"]',
    'input',
  ].join(', ')).filter({ visible: true }).all();

  if (inputs.length >= 6) {
    for (let i = 0; i < 6; i += 1) await inputs[i].fill(code[i]);
    return { ok: true, mode: 'six_inputs', count: inputs.length };
  }
  if (inputs.length === 1) {
    await inputs[0].fill(code);
    return { ok: true, mode: 'single_input', count: 1 };
  }

  if (page?.keyboard) {
    await page.keyboard.type(code);
    return { ok: true, mode: 'keyboard', count: inputs.length };
  }

  return { ok: false, mode: 'no_inputs', count: inputs.length };
}

async function clickExactText(scope, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loc = scope.getByText(pattern).filter({ visible: true }).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click();
      return true;
    }

    const clicked = await scope.evaluate((source, flags) => {
      const re = new RegExp(source, flags);
      const norm = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const candidates = Array.from(document.querySelectorAll('button, [role="button"], a'))
        .map((el) => ({ el, text: norm(el.innerText || el.textContent || el.getAttribute('aria-label')) }))
        .filter(({ el, text }) => text && re.test(text) && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length));
      candidates.sort((a, b) => a.text.length - b.text.length);
      const target = candidates[0]?.el;
      if (!target) return false;
      target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      target.click();
      return true;
    }, pattern.source, pattern.flags).catch(() => false);
    if (clicked) return true;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

export async function clickAppleTrustBrowser(page, frame, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  if (frame && await clickExactText(frame, /^Trust$/i, timeoutMs).catch(() => false)) return true;
  if (page && await clickExactText(page, /^Trust$/i, timeoutMs).catch(() => false)) return true;
  return false;
}

export async function completeAppleNativeTwoFactorChallenge(session, frame, options = {}) {
  const codeResult = await waitForAppleNativeTwoFactorCode(session, options);
  if (!codeResult.ok) return { ...codeResult, filled: false, trustClicked: false };

  const page = options.page || session?.page;
  const fillResult = await fillAppleTwoFactorCode(frame || page, page, codeResult.code);
  if (!fillResult.ok) {
    return { ...codeResult, ok: false, filled: false, fillResult, trustClicked: false };
  }

  if (session?.wait) await session.wait(2);
  const trustClicked = await clickAppleTrustBrowser(page, frame, options).catch(() => false);
  if (trustClicked && options.logPrefix) console.log(`${options.logPrefix} clicked trust browser`);

  return {
    ...codeResult,
    filled: true,
    fillResult,
    trustClicked,
  };
}
