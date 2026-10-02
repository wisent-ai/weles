// The Brave proof-of-work challenge: a registration form that computes its
// own solution in the page and enables its button when done. Nothing to
// solve remotely; the page itself is asked to report when the form changes.

// Resolves in the page, on an animation frame, once the challenge form shows
// one of the outcomes the caller is watching for (or has gone away).
async function braveFormChanged(page: Page, phase: 'validation' | 'calculation'): Promise<void> {
  await page.waitForFunction((which: string) => {
    const solution = document.querySelector<HTMLInputElement>('input[name="captchaSolution"]');
    const button = document.querySelector<HTMLButtonElement>('#captcha-button');
    if (!solution || !button) return true;
    const form = button.closest('form');
    if (form && !form.checkValidity()) return true;
    const alerted = Array.from(document.querySelectorAll<HTMLElement>('.alert, [role="alert"], .error'))
      .some(element => element.innerText.trim().length > 0);
    if (alerted && (which === 'validation' || !/verifying/i.test(button.innerText))) return true;
    if (which === 'validation') return !button.disabled;
    return solution.value.length > 0 || /verified/i.test(button.innerText);
  }, phase, { polling: 'raf' });
}

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
  return await page.evaluate(() => {
    const solution = document.querySelector<HTMLInputElement>('input[name="captchaSolution"]');
    const button = document.querySelector<HTMLButtonElement>('#captcha-button');
    if (!solution || !button) return null;
    const form = button.closest('form');
    const errorText = Array.from(document.querySelectorAll<HTMLElement>('.alert, [role="alert"], .error'))
      .map(element => element.innerText.trim())
      .filter(Boolean)
      .join(' ');
    return {
      present: true,
      formValid: form?.checkValidity() ?? false,
      buttonDisabled: button.disabled,
      buttonText: button.innerText.trim(),
      solutionLength: solution.value.length,
      errorText,
      url: location.href,
    };
  });
}

export async function solveBraveProofOfWork(page: Page, initial: BraveProofOfWorkState): Promise<boolean> {
  let ready = initial;
  if (!ready.formValid) {
    console.log('[captcha] Brave proof-of-work blocked: registration form is invalid');
    return false;
  }

  if (ready.buttonDisabled && ready.solutionLength === 0) {
    console.log('[captcha] Brave proof-of-work waiting for registration validation');
    await braveFormChanged(page, 'validation');
    const state = await braveProofOfWorkState(page);
    if (!state) return false;
    ready = state;
    if (!ready.formValid) {
      console.log('[captcha] Brave proof-of-work blocked: registration form became invalid');
      return false;
    }
    if (ready.errorText) {
      console.log(`[captcha] Brave proof-of-work validation failed: ${ready.errorText}`);
      return false;
    }
  }

  let started = /verifying/i.test(ready.buttonText);
  if (!started && ready.solutionLength === 0) {
    await page.locator('#captcha-button').click();
    started = true;
    console.log('[captcha] Brave proof-of-work calculation started');
  }

  if (ready.solutionLength > 0 || /verified/i.test(ready.buttonText)) return true;
  const initialURL = ready.url;
  for (;;) {
    try {
      await braveFormChanged(page, 'calculation');
    } catch (error) {
      // The form submitting itself replaces the document under the wait.
      if (!/Execution context was destroyed/i.test(String(error))) throw error;
      await page.waitForLoadState('domcontentloaded');
    }
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
      return true;
    }
    if (state.url !== initialURL) {
      console.log('[captcha] Brave proof-of-work navigated after submission');
      return true;
    }
    if (state.errorText && !/verifying/i.test(state.buttonText)) {
      console.log(`[captcha] Brave proof-of-work failed: ${state.errorText}`);
      return false;
    }
    if (!state.formValid) {
      console.log(`[captcha] Brave proof-of-work blocked: registration form became invalid started=${started}`);
      return false;
    }
  }
}
