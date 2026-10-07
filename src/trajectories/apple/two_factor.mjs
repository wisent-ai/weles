import { pageSettled } from '../_shared/page/settled.mjs';
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

  if (inputs.length === 1) {
    await humanFill(page, inputs[0], code);
    return { ok: true, mode: 'single_input', count: 1 };
  }
  // Apple shows one box per digit of the code it sent; the code's own length
  // says how many boxes to fill.
  if (inputs.length >= code.length) {
    for (const [index, digit] of [...code].entries()) await humanFill(page, inputs[index], digit);
    return { ok: true, mode: 'one_input_per_digit', count: inputs.length };
  }
  if (page?.keyboard) {
    await humanType(page, code);
    return { ok: true, mode: 'keyboard', count: inputs.length };
  }
  return { ok: false, mode: 'no_inputs', count: inputs.length };
}

// Click the control if the page is showing it. The old shape polled for
// fifteen seconds and called the absence of a button a timeout; what this
// asks is a fact the page either states now or does not, and the caller
// treats `false` as "Apple did not offer the trust prompt".
async function clickExactText(scope, page, pattern) {
  const locator = scope.getByText(pattern).filter({ visible: true }).first();
  if (await locator.isVisible().catch(() => false)) {
    await humanClickLocator(page, locator);
    return true;
  }
  const fallback = scope.locator('button, [role="button"], a').filter({ hasText: pattern }).filter({ visible: true }).first();
  return await humanClickLocator(page, fallback).then(() => true).catch(() => false);
}

export async function clickAppleTrustBrowser(page, frame) {
  if (frame && await clickExactText(frame, page, /^Trust$/i).catch(() => false)) return true;
  if (page && await clickExactText(page, page, /^Trust$/i).catch(() => false)) return true;
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
  await pageSettled(page);
  const trustClicked = await clickAppleTrustBrowser(page, frame).catch(() => false);
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
