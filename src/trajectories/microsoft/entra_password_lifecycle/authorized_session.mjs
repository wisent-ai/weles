// How a signed-in Entra session comes about on the converged Microsoft screens,
// and what happens the moment a fresh login has proven something: the reads and
// fills those screens need, the sign-in walk itself, and the Skarbiec commit
// that only an asserted identity is allowed to reach.
//
// Reading a screen and waiting for a control are evidence here, not decoration.
// Every read that did not happen therefore has a name of its own -
// PAGE_TEXT_UNREADABLE, or a false from a wait that never proved the control -
// and each caller branches on that name instead of on an empty string that would
// read like a screen which said nothing.
//
// Moved out of entra_password_lifecycle.mjs, which keeps the three trajectory
// entry points.

import { humanFill, humanType } from '../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../dist/human/mouse.js';

import { persistFreshCookieJar } from '../../_shared/cookie-freshness.mjs';
import { commitPassword, outcome } from './answer_and_custody.mjs';
import { assertEntraIdentity } from './proven_identity.mjs';
import {
  AUTHORIZED_CONTEXT_HOST,
  AUTHORIZED_CONTEXT_URL,
  AUTHORIZED_CONTEXT_URL_PATTERN,
  updateAccountReference,
} from './queued_job.mjs';

export const IDENTITY_CHALLENGE = /verify your identity|get a code|approve (?:a )?sign.?in|enter.{0,20}code|passkey|security key|authenticator app|text my mobile|call my (?:mobile|office)|verification (?:step|method)/i;
const PASSWORD_REJECTED = /your account or password is incorrect|password is incorrect|wrong password|password is invalid/i;
const USERNAME_UNKNOWN = /isn.t in our system|couldn.t find your account|try entering your details again/i;
export const PAGE_TEXT_UNREADABLE = 'page_text_unreadable';
export const IDENTITY_CHALLENGE_PRESENT = 'identity_challenge_present';
const IDENTITY_CHALLENGE_ABSENT = 'identity_challenge_absent';
const STAY_SIGNED_IN_SETTLED = 'stay_signed_in_settled';

export async function visible(locator) {
  const count = await locator.count().catch(() => Number('0'));
  return count > Number('0') && locator.first().isVisible().catch(() => false);
}

// The wait itself is the proof that a control arrived, so its refusal is an
// answer the caller names, not an error the caller never hears about.
export async function appears(locator, waitMs) {
  try {
    await locator.waitFor({ state: 'visible', timeout: waitMs });
    return true;
  } catch {
    return false;
  }
}

async function settledOnUrl(page, pattern, waitMs) {
  try {
    await page.waitForURL(pattern, { timeout: waitMs });
    return true;
  } catch {
    return false;
  }
}

// The rendered text of a Microsoft screen is what every verdict below is read
// from, so a text this run never got is its own answer carrying the reason.
export async function pageText(page) {
  try {
    return { ok: true, text: await page.locator('body').innerText() };
  } catch (error) {
    return { ok: false, reason: `the page text could not be read: ${error.message}` };
  }
}

async function controlValue(locator) {
  try {
    return { ok: true, value: await locator.inputValue() };
  } catch (error) {
    return { ok: false, reason: `the control value could not be read back: ${error.message}` };
  }
}

export async function fill(page, locator, value) {
  await locator.waitFor({ state: 'visible', timeout: Number('30000') });
  await humanFill(page, locator, value);
}

// The converged control re-renders during hydration and can silently drop
// keystrokes of a human-typed value — sometimes after an immediate readback
// already looked right — so every fill settles, reads back, and retries
// before the form moves on. A readback that disagreed leaves the form's own
// verdict to decide; a readback that never reached the control at all proves
// nothing about the typed value and is raised.
async function fillVerified(page, locator, value) {
  let readback;
  for (let attempt = Number('0'); attempt < Number('3'); attempt += Number('1')) {
    await fill(page, locator, value);
    await page.waitForTimeout(Number('800'));
    readback = await controlValue(locator);
    if (readback.ok && readback.value === value) return;
  }
  if (!readback.ok) {
    throw new Error(`a typed sign-in value could not be verified: ${readback.reason}`);
  }
}

// 'identity_challenge_present' | 'identity_challenge_absent' | 'page_text_unreadable'
export async function identityChallengeState(page) {
  const body = await pageText(page);
  if (!body.ok) return PAGE_TEXT_UNREADABLE;
  return IDENTITY_CHALLENGE.test(body.text) ? IDENTITY_CHALLENGE_PRESENT : IDENTITY_CHALLENGE_ABSENT;
}

// 'stay_signed_in_settled' | 'page_text_unreadable'
async function dismissStaySignedIn(page) {
  const body = await pageText(page);
  if (!body.ok) return PAGE_TEXT_UNREADABLE;
  if (!/stay signed in/i.test(body.text)) return STAY_SIGNED_IN_SETTLED;
  const decline = page.getByRole('button', { name: /^No$/i }).first();
  if (await visible(decline)) {
    await humanClickLocator(page, decline);
    await humanIdlePause('long');
  }
  return STAY_SIGNED_IN_SETTLED;
}

// Walks the converged sign-in surfaces until the password credential is
// chosen. The passkey-first page cancels into an error surface whose
// "Other ways to sign in" carries the password tile; the bare "Sign-in
// options" chooser (passkey + organization) does not, so it is backed out of
// and the email is resubmitted for another pass at the error surface.
async function choosePasswordSignIn(page) {
  for (let attempt = Number('0'); attempt < Number('4'); attempt += Number('1')) {
    const passwordInput = page.locator('input[name="passwd"], input#i0118, input[type="password"]').first();
    if (await visible(passwordInput)) return;
    const passwordChoice = page.getByText(/^Use (?:your )?password$/i).first();
    if (await visible(passwordChoice)) {
      await humanClickLocator(page, passwordChoice);
      await page.waitForTimeout(Number('1000'));
      return;
    }
    const passkeyFailed = page.getByText(/couldn.t sign you in with your passkey|something went wrong/i).first();
    const passkeyPage = page.getByText(/Face, fingerprint, PIN or security key|device will open a security window/i).first();
    const bareChooser = page.getByText(/Sign in to an organization/i).first();
    const emailInput = page.locator('input[name="loginfmt"], input#i0116, input[type="email"]').first();
    if (await visible(passkeyFailed)) {
      const otherWays = page.getByText(/Other ways to sign in|Use another way/i).first();
      if (await visible(otherWays)) {
        await humanClickLocator(page, otherWays);
        await page.waitForTimeout(Number('1000'));
        continue;
      }
    }
    if (await visible(passkeyPage)) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(Number('2500'));
      continue;
    }
    if (await visible(bareChooser)) {
      const back = page.locator('#idBtn_Back, button[aria-label="Back"]').first();
      if (!await visible(back)) return;
      await humanClickLocator(page, back);
      await page.waitForTimeout(Number('1000'));
      continue;
    }
    if (await visible(emailInput)) {
      const next = page.locator('input[type="submit"]#idSIButton9, button[type="submit"]').first();
      if (!await visible(next)) return;
      await humanClickLocator(page, next);
      await page.waitForTimeout(Number('2500'));
      continue;
    }
    const otherWays = page.getByText(/Other ways to sign in|Use another way/i).first();
    if (!await visible(otherWays)) return;
    await humanClickLocator(page, otherWays);
    await page.waitForTimeout(Number('1000'));
  }
}

// The token cache of an earlier authorized context has to go before this login,
// so the claims asserted afterwards are evidence of this login. A cache that
// could not be dropped is named, because reading the earlier login's tokens
// would prove the wrong session.
async function clearTokenCache(page) {
  try {
    await page.evaluate(() => {
      globalThis.localStorage?.clear();
      globalThis.sessionStorage?.clear();
    });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: `the authorized context token cache could not be cleared: ${error.message}` };
  }
}

// 'authenticated' | 'rejected' | 'identity_challenge' | 'unavailable'
export async function signIn(session, contract, password) {
  const page = session.page;
  if (AUTHORIZED_CONTEXT_HOST.test(new URL(page.url()).hostname)) {
    const cleared = await clearTokenCache(page);
    if (!cleared.ok) return 'unavailable';
  }
  await session.ctx.clearCookies();
  await page.goto(AUTHORIZED_CONTEXT_URL, { waitUntil: 'domcontentloaded' });
  await humanIdlePause('deliberate');
  const emailInput = page.locator('input[name="loginfmt"], input#i0116, input[type="email"]').first();
  if (!await appears(emailInput, Number('45000')) || !await visible(emailInput)) return 'unavailable';
  // A truncated username submit lands on the "isn't in our system" surface,
  // which still renders a (hidden) password input; detect it and resubmit the
  // full UPN instead of letting the password stage type into that page.
  for (let attempt = Number('0'); attempt < Number('3'); attempt += Number('1')) {
    await fillVerified(page, emailInput, contract.accountUpn);
    await humanClickLocator(page, page.locator('input[type="submit"]#idSIButton9, button[type="submit"]').first());
    await humanIdlePause('deliberate');
    const named = await pageText(page);
    if (!named.ok) return 'unavailable';
    if (!USERNAME_UNKNOWN.test(named.text)) break;
  }
  await choosePasswordSignIn(page);
  const passwordInput = page.locator('input[name="passwd"], input#i0118, input[type="password"]').first();
  if (!await appears(passwordInput, Number('45000')) || !await visible(passwordInput)) {
    return await identityChallengeState(page) === IDENTITY_CHALLENGE_PRESENT ? 'identity_challenge' : 'unavailable';
  }
  await fillVerified(page, passwordInput, password);
  await humanClickLocator(page, page.locator('input[type="submit"]#idSIButton9, button[type="submit"]').first());
  await humanIdlePause('long');
  const answered = await pageText(page);
  if (!answered.ok) return 'unavailable';
  if (PASSWORD_REJECTED.test(answered.text)) return 'rejected';
  if (await visible(page.locator('input[name="passwd"], input#i0118'))) return 'rejected';
  if (await dismissStaySignedIn(page) === PAGE_TEXT_UNREADABLE) return 'unavailable';
  const challenged = await identityChallengeState(page);
  if (challenged === IDENTITY_CHALLENGE_PRESENT) return 'identity_challenge';
  if (challenged === PAGE_TEXT_UNREADABLE) return 'unavailable';
  if (!await settledOnUrl(page, AUTHORIZED_CONTEXT_URL_PATTERN, Number('60000'))
      || !AUTHORIZED_CONTEXT_HOST.test(new URL(page.url()).hostname)) {
    return await identityChallengeState(page) === IDENTITY_CHALLENGE_PRESENT ? 'identity_challenge' : 'unavailable';
  }
  return 'authenticated';
}

// Shared tail: fresh login with the value the provider now holds, full identity
// assertion, then the Skarbiec commit. Never commits an unasserted identity.
export async function commitAfterFreshLogin(session, account, contract, plan) {
  const { password, writeOperation, sink, proxyUrl, providerEffect, evidence } = plan;
  const signedIn = await signIn(session, contract, password);
  evidence.push(`fresh_login_verification:${signedIn}`);
  if (signedIn !== 'authenticated') {
    return {
      committed: false,
      answer: outcome(contract, {
        status: signedIn === 'identity_challenge' ? 'needs_human_approval' : 'operation_failed',
        code: signedIn === 'identity_challenge'
          ? 'ENTRA_FRESH_LOGIN_REQUIRES_HUMAN_APPROVAL'
          : 'ENTRA_FRESH_LOGIN_FAILED',
        phase: signedIn === 'identity_challenge' ? 'identity_verification' : 'fresh_login_verification',
        retryable: signedIn !== 'rejected',
        providerEffect,
        reason: signedIn === 'identity_challenge'
          ? 'the fresh Entra login after the password write needs interactive identity approval'
          : 'the fresh Entra login with the newly written password did not authenticate',
      }),
    };
  }
  const identity = await assertEntraIdentity(session, contract, sink);
  if (!identity.ok) {
    return {
      committed: false,
      answer: outcome(contract, {
        status: 'operation_failed',
        code: identity.code,
        phase: 'identity_verification',
        retryable: identity.retryable,
        providerEffect,
        reason: identity.reason,
      }),
    };
  }
  evidence.push('identity_verification:confirmed');
  try {
    commitPassword(contract, password, writeOperation);
    await updateAccountReference(account, contract);
  } catch {
    return { committed: false, answer: null };
  }
  evidence.push(`skarbiec_commit:${writeOperation}`);
  const cookies = await session.ctx.cookies();
  await persistFreshCookieJar(account, cookies, { currentProxyUrl: proxyUrl });
  return { committed: true, answer: null };
}
