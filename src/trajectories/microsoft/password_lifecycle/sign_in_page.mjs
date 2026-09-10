import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { runRecordingsDir } from '../../../../dist/session/run-recordings.js';
import { humanFill } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';
import {
  CODE_FILE_MAX_BYTES, CODE_FILE_MODE, CODE_FILE_MODE_MASK, CODE_FILE_WAIT_MS, DISMISS_SETTLE_MS, FIELD_WAIT_MS,
  IDENTITY_CHALLENGE, LOGIN_HOSTS, PAGE_SETTLE_MS, PASSWORD_PAGE_WAIT_MS, SECOND_PASSWORD_INPUT, STEP_SETTLE_MS,
} from './constants.mjs';

const CODE_INPUT = 'input[type="tel"], input[type="number"], input[inputmode="numeric"], input[name*="otc" i], input[name*="code" i], input[type="text"]';

/** Whether the locator resolves to at least one visible element. */
export async function visible(locator) {
  const count = await locator.count().catch(() => false);
  return count > 0 && locator.first().isVisible().catch(() => false);
}

/** The page's text, or '' with a log line when the page refused to give it. */
export async function bodyText(page) {
  try {
    return await page.locator('body').innerText();
  } catch (error) {
    console.log(`[microsoft] page text unreadable: ${String(error?.message ?? error).slice(0, 120)}`);
    return '';
  }
}

/** A key press the page refuses is logged; the step decides what it means. */
export async function press(page, key) {
  try { await page.keyboard.press(key); } catch (error) { console.log(`[microsoft] key ${key} not delivered: ${String(error?.message ?? error).slice(0, 120)}`); }
}

/** A value from the page's own config object; false when the page has none. */
export function pageConfig(page, read) {
  return page.evaluate(read).catch(() => false);
}

/** Wait for the field to be visible, then fill it through the humanized atoms. */
export async function fill(page, locator, value) {
  await locator.waitFor({ state: 'visible', timeout: FIELD_WAIT_MS });
  await humanFill(page, locator, value);
}

/** Leave a passkey prompt for the password sign-in, on the login origin only. */
export async function choosePasswordSignIn(page, selectPassword = true) {
  const passkeyPage = page.getByText(/Face, fingerprint, PIN or security key|device will open a security window/i).first();
  if (await visible(passkeyPage)) {
    await press(page, 'Escape');
    await page.waitForTimeout(DISMISS_SETTLE_MS);
    const resume = await pageConfig(page, () => globalThis.$Config?.urlCancel ?? globalThis.$Config?.urlResume ?? '');
    if (resume) {
      const target = new URL(resume, page.url());
      if (!LOGIN_HOSTS.includes(target.hostname)) {
        throw new Error('Microsoft passkey resume URL escaped the login origin');
      }
      await page.goto(target.href, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(PAGE_SETTLE_MS);
    } else {
      const back = page.locator('#idBtn_Back, button[aria-label="Back"]').first();
      if (await visible(back)) {
        await humanClickLocator(page, back);
        await page.waitForTimeout(PAGE_SETTLE_MS);
      }
    }
  }
  const otherWays = page.getByText(/Other ways to sign in|Sign-in options|Use another way/i).first();
  if (await visible(otherWays)) {
    await humanClickLocator(page, otherWays);
    await page.waitForTimeout(PAGE_SETTLE_MS);
  }
  if (selectPassword) {
    const passwordChoice = page.getByText(/Use (?:your )?password|Password/i).first();
    if (await visible(passwordChoice)) {
      await humanClickLocator(page, passwordChoice);
      await page.waitForTimeout(PAGE_SETTLE_MS);
    }
  }
}

export async function hasIdentityChallenge(page) {
  return IDENTITY_CHALLENGE.test(await bodyText(page));
}

/**
 * The verification code the operator drops into the named file: owner-only,
 * small, digits only, consumed once. False when no file is configured or
 * none arrived in time.
 */
async function waitForVerificationCode(page) {
  const codeFile = process.env.MICROSOFT_VERIFICATION_CODE_FILE?.trim() ?? '';
  if (!codeFile) return false;
  if (!isAbsolute(codeFile) || basename(codeFile) !== 'microsoft-verification-code') {
    throw new Error('invalid Microsoft verification-code file path');
  }
  const deadline = Date.now() + CODE_FILE_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      const metadata = statSync(codeFile);
      if (!metadata.isFile()
          || metadata.uid !== process.getuid()
          || (metadata.mode & CODE_FILE_MODE_MASK) !== CODE_FILE_MODE
          || metadata.size > CODE_FILE_MAX_BYTES) {
        throw new Error('Microsoft verification-code file failed owner, mode, or size validation');
      }
      const code = readFileSync(codeFile, 'utf8').trim();
      if (!/^\d{4,8}$/.test(code)) {
        throw new Error('Microsoft verification-code file contains an invalid code');
      }
      unlinkSync(codeFile);
      return code;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    await page.waitForTimeout(PAGE_SETTLE_MS);
  }
  return false;
}

/** The page that shows the new-password form once the challenge is done, or false. */
async function waitForPasswordPage(page) {
  let statePage = page;
  const deadline = Date.now() + PASSWORD_PAGE_WAIT_MS;
  while (Date.now() < deadline) {
    const pages = page.context().pages().filter((candidate) => !candidate.isClosed()).reverse();
    for (const candidate of pages) {
      if (/account\.live\.com\/password\/Change/i.test(candidate.url())) statePage = candidate;
      if (/stay signed in/i.test(await bodyText(candidate))) {
        const no = candidate.getByRole('button', { name: /^No$/i }).first();
        if (await visible(no)) {
          await humanClickLocator(candidate, no);
          await humanIdlePause('long');
        }
      }
      if (await visible(candidate.locator('input[type="password"]').nth(SECOND_PASSWORD_INPUT))) {
        return { passwordPage: candidate, statePage: candidate };
      }
    }
    await page.waitForTimeout(PAGE_SETTLE_MS);
  }
  return { passwordPage: false, statePage };
}

/**
 * Prove identity through the email code Microsoft sends: choose the email
 * option, confirm the address when asked, enter the code the operator
 * supplied, and return the page that then shows the password form (or false
 * when the challenge could not be completed).
 */
export async function completeEmailIdentityChallenge(page, email) {
  let sendEmail = page.getByRole('group', {
    name: new RegExp(`Send a code to ${email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i'),
  }).first();
  if (!await visible(sendEmail)) {
    const otherOption = page.getByText(/Use a different verification option|Other ways to verify|Use another way/i).first();
    if (await visible(otherOption)) {
      await humanClickLocator(page, otherOption);
      await humanIdlePause('long');
    }
    sendEmail = page.getByLabel(/Email.*@/i).last();
    if (!await visible(sendEmail)) {
      sendEmail = page.getByText(/Email.*@|Send a code to.*@/i).last();
    }
  }
  if (!await visible(sendEmail)) return false;
  await humanClickLocator(page, sendEmail);
  const requestCode = page.getByRole('button', { name: /Get code|Send code|Next/i }).first();
  if (await visible(requestCode)) {
    await humanClickLocator(page, requestCode);
    await humanIdlePause('long');
  }
  await page.waitForTimeout(STEP_SETTLE_MS);

  let body = await bodyText(page);
  let visibleInput = page.locator('input:not([type="hidden"]):not([type="submit"]):not([type="button"])').first();
  if (/enter.{0,40}(email|address)|confirm.{0,40}(email|address)|matches the email address|email address on your account/i.test(body)
      && await visible(visibleInput)) {
    await fill(page, visibleInput, email);
    const send = page.getByRole('button', { name: /Next|Send code|Send/i }).first();
    if (!await visible(send)) return false;
    await humanClickLocator(page, send);
    await page.waitForTimeout(STEP_SETTLE_MS);
  }

  body = await bodyText(page);
  if (!/code/i.test(body)) return false;
  visibleInput = page.locator(CODE_INPUT).first();
  if (!await visible(visibleInput)) return false;
  const code = await waitForVerificationCode(page);
  if (!code) return false;
  visibleInput = page.locator(CODE_INPUT).first();
  await fill(page, visibleInput, code);
  const verify = page.getByRole('button', { name: /Verify|Next|Submit|Continue/i }).first();
  if (!await visible(verify)) return false;
  await humanClickLocator(page, verify);
  await humanIdlePause('long');
  const { passwordPage, statePage } = await waitForPasswordPage(page);
  const passwordReady = Boolean(passwordPage);
  const resultBody = await bodyText(statePage);
  if (!passwordReady
      && /code.{0,40}(incorrect|invalid|expired|didn.t work)|wrong.{0,20}code/i.test(resultBody)) {
    throw new Error('Microsoft email verification code was rejected');
  }
  writeFileSync(join(runRecordingsDir(), 'microsoft_identity_state.json'), JSON.stringify({
    stage: 'email_challenge_complete',
    passwordReady,
    passwordCount: await statePage.locator('input[type="password"]').count(),
    pageCount: page.context().pages().length,
    url: statePage.url(),
    title: await statePage.title().catch((error) => `unreadable: ${error.message}`),
    body: resultBody,
    inputs: await statePage.locator('input').evaluateAll((nodes) => nodes.map((node) => ({
      type: node.getAttribute('type'),
      name: node.getAttribute('name'),
      id: node.id,
      ariaLabel: node.getAttribute('aria-label'),
      autocomplete: node.getAttribute('autocomplete'),
      outerHTML: node.outerHTML.slice(0, 1000),
    }))).catch((error) => [{ unreadable: error.message }]),
  }, null, 2));
  return passwordPage;
}
