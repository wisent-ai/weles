import { pageSettled, responseAfterAction } from '../../page/settled.mjs';

// Native document forms only: the form's declared POST and its redirect chain
// determine when submission ended. A completed submit is not account approval.
export async function submitLoginForm(page, passwordField) {
  const form = await passwordField.evaluate(input => {
    const owner = input.form;
    if (!owner) return null;
    return {
      action: owner.action,
      method: owner.method.toUpperCase(),
      invalidFields: Array.from(owner.elements)
        .filter(element => element.willValidate && !element.validity.valid)
        .map(element => ({ name: element.name, message: element.validationMessage })),
    };
  });
  const pageUrl = page.url();
  if (!form || form.method !== 'POST' || new URL(form.action).origin !== new URL(pageUrl).origin) {
    throw Object.assign(new Error('login input does not belong to a same-origin POST form'), {
      code: 'NATIVE_LOGIN_FORM_UNSUPPORTED', pageUrl, form,
    });
  }
  if (form.invalidFields.length) {
    throw Object.assign(new Error('login form has invalid input before submission'), {
      code: 'NATIVE_LOGIN_INPUT_INVALID', pageUrl, invalidFields: form.invalidFields,
    });
  }
  const first = await responseAfterAction(page,
    request => request.method() === form.method && request.url() === form.action
      && request.isNavigationRequest() && request.frame() === page.mainFrame(),
    () => passwordField.press('Enter'));
  let response = first;
  for (;;) {
    const request = response.request();
    const cause = await response.finished();
    const details = { requestUrl: form.action, responseUrl: response.url(), status: response.status() };
    if (cause) throw Object.assign(new Error('login document response did not finish', { cause }), {
      code: 'NATIVE_LOGIN_RESPONSE_FAILED', ...details,
    });
    const redirected = request.redirectedTo();
    if (!redirected) {
      if (!response.ok()) throw Object.assign(new Error('login document returned an unsuccessful HTTP status'), {
        code: 'NATIVE_LOGIN_HTTP_ERROR', ...details,
      });
      break;
    }
    response = await redirected.response();
    if (!response) throw Object.assign(new Error('login redirect did not return a response'), {
      code: 'NATIVE_LOGIN_REDIRECT_FAILED', ...details,
      redirectUrl: redirected.url(), errorText: redirected.failure()?.errorText ?? null,
    });
  }
  await pageSettled(page);
  const observed = new URL(page.url());
  const submitted = new URL(form.action);
  if (observed.origin !== submitted.origin || observed.pathname === submitted.pathname) {
    throw Object.assign(new Error('login submission did not leave its login page on the same provider'), {
      code: 'NATIVE_LOGIN_NOT_COMPLETED', requestUrl: form.action,
      responseUrl: response.url(), status: response.status(), pageUrl: observed.href,
      providerText: await page.locator('body').innerText(),
    });
  }
  return response;
}
