import { humanClickLocator } from '../../../dist/human/mouse.js';
import { humanFill, humanType } from '../../../dist/human/keyboard.js';

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
    for (let index = 0; index < 6; index += 1) await humanFill(page, inputs[index], code[index]);
    return { ok: true, mode: 'six_inputs', count: inputs.length };
  }
  if (inputs.length === 1) {
    await humanFill(page, inputs[0], code);
    return { ok: true, mode: 'single_input', count: 1 };
  }
  if (page?.keyboard) {
    await humanType(page, code);
    return { ok: true, mode: 'keyboard', count: inputs.length };
  }
  return { ok: false, mode: 'no_inputs', count: inputs.length };
}

async function clickExactText(scope, pattern, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const locator = scope.getByText(pattern).filter({ visible: true }).first();
    if (await locator.isVisible().catch(() => false)) {
      await humanClickLocator(page, locator);
      return true;
    }
    const fallback = scope.locator('button, [role="button"], a').filter({ hasText: pattern }).filter({ visible: true }).first();
    const clicked = await humanClickLocator(page, fallback).then(() => true).catch(() => false);
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

async function completeAppleTwoFactorCode(session, frame, options, code) {
  if (!/^\d{6}$/.test(code || '')) throw new Error('Apple 2FA provider returned an invalid code');
  const page = options.page || session?.page;
  const fillResult = await fillAppleTwoFactorCode(frame || page, page, code);
  if (!fillResult.ok) {
    return {
      ok: false,
      source: 'capability',
      filled: false,
      fillResult,
      trustClicked: false,
    };
  }
  if (session?.wait) await session.wait(2);
  const trustClicked = await clickAppleTrustBrowser(page, frame, options).catch(() => false);
  if (trustClicked && options.logPrefix) console.log(`${options.logPrefix} clicked trust browser`);
  return {
    ok: true,
    source: 'capability',
    filled: true,
    fillResult,
    trustClicked,
  };
}

export async function completeAppleTwoFactorChallenge(session, frame, options = {}) {
  if (typeof options.withCode !== 'function') {
    throw new Error('Apple 2FA requires an authorization-bound capability provider');
  }
  return options.withCode((code) => completeAppleTwoFactorCode(
    session,
    frame,
    options,
    code,
  ));
}
