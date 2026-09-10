// The Brave proof-of-work challenge: a registration form that computes its
// own solution in the page and enables its button when done. Nothing to
// solve remotely; the page is watched until it finishes or gives up.

import { humanIdlePause } from '../human/mouse.js';

type Page = any;

export interface BraveProofOfWorkState {
  present: boolean;
  formValid: boolean;
  buttonDisabled: boolean;
  buttonText: string;
  solutionLength: number;
  errorText: string;
  url: string;
}

export async function braveProofOfWorkState(page: Page): Promise<BraveProofOfWorkState | null> {
  return await page.evaluate?.(() => {
    const solution = document.querySelector<HTMLInputElement>('input[name="captchaSolution"]');
    const button = document.querySelector<HTMLButtonElement>('#captcha-button');
    if (!solution || !button) return null;
    const form = button.closest('form');
    const errorText = Array.from(document.querySelectorAll<HTMLElement>('.alert, [role="alert"], .error'))
      .map(element => element.innerText.trim())
      .filter(Boolean)
      .join(' ')
      .slice(0, 500);
    return {
      present: true,
      formValid: form?.checkValidity() ?? false,
      buttonDisabled: button.disabled,
      buttonText: button.innerText.trim(),
      solutionLength: solution.value.length,
      errorText,
      url: location.href,
    };
  }).catch(() => null) ?? null;
}

export async function solveBraveProofOfWork(page: Page, initial: BraveProofOfWorkState): Promise<boolean> {
  let ready = initial;
  if (!ready.formValid) {
    console.log('[captcha] Brave proof-of-work blocked: registration form is invalid');
    return false;
  }

  if (ready.buttonDisabled && ready.solutionLength === 0) {
    console.log('[captcha] Brave proof-of-work waiting for registration validation');
    for (let attempt = 0; attempt < 60 && ready.buttonDisabled; attempt++) {
      await humanIdlePause('short');
      const state = await braveProofOfWorkState(page);
      if (!state) return false;
      ready = state;
      if (!ready.formValid) {
        console.log('[captcha] Brave proof-of-work blocked: registration form became invalid');
        return false;
      }
      if (ready.errorText) {
        console.log(`[captcha] Brave proof-of-work validation failed: ${ready.errorText.slice(0, 160)}`);
        return false;
      }
    }
    if (ready.buttonDisabled) {
      console.log('[captcha] Brave proof-of-work button remained disabled after validation');
      return false;
    }
  }

  let started = /verifying/i.test(ready.buttonText);
  if (!started && ready.solutionLength === 0) {
    try {
      await page.locator('#captcha-button').click({ timeout: 10_000 });
      started = true;
      console.log('[captcha] Brave proof-of-work calculation started');
    } catch (error) {
      console.log(`[captcha] Brave proof-of-work click failed: ${error instanceof Error ? error.message.slice(0, 120) : String(error).slice(0, 120)}`);
      return false;
    }
  }

  if (ready.solutionLength > 0 || /verified/i.test(ready.buttonText)) return true;
  const initialURL = ready.url;
  for (let attempt = 0; attempt < 240; attempt++) {
    await humanIdlePause('short');
    const state = await braveProofOfWorkState(page);
    if (!state) {
      const currentURL = page.url?.() ?? '';
      if (currentURL !== initialURL) {
        console.log('[captcha] Brave proof-of-work submitted the registration form');
        return true;
      }
      console.log('[captcha] Brave proof-of-work form disappeared after calculation');
      return true;
    }
    if (state.solutionLength > 0 || /verified/i.test(state.buttonText)) {
      console.log(`[captcha] Brave proof-of-work solved solution_length=${state.solutionLength}`);
      await humanIdlePause('deliberate');
      return true;
    }
    if (state.url !== initialURL) {
      console.log('[captcha] Brave proof-of-work navigated after submission');
      return true;
    }
    if (state.errorText && !/verifying/i.test(state.buttonText)) {
      console.log(`[captcha] Brave proof-of-work failed: ${state.errorText.slice(0, 160)}`);
      return false;
    }
  }
  console.log(`[captcha] Brave proof-of-work timed out started=${started}`);
  return false;
}
