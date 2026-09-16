// Credential and identity fills: the value never reaches the model or the
// log, only the page field the capability was minted for. Split out of
// finalize.ts, which keeps the click, fill and close primitives.
import { assertNonCredentialInput, withCapability } from '../../../utils/capability.js';
import type { CapabilityRef } from '../../../utils/capability.js';
import type { WSession } from '../../wsession.js';
import type { ElementHandle, Page } from 'playwright';
import { setTimeout as delay } from 'node:timers/promises';
import { fillPage } from '../finalize.js';
import { humanFill } from '../../../human/keyboard.js';
import { describeInputTarget, resolveObservedControl } from '../../observation/controls.js';

type CredentialFieldClass = 'password' | 'email' | 'username' | 'token' | 'api-key';
type IdentityField = 'email' | 'password' | 'username' | 'first_name' | 'last_name' | 'birth_month' | 'birth_day' | 'birth_year';

const CREDENTIAL_FIELD_HINTS: Record<CredentialFieldClass, RegExp> = {
  password: /password|passcode|secret/,
  email: /email|e-mail/,
  username: /username|user name|login/,
  token: /token|verification code|one-time code|otp/,
  'api-key': /api.?key|access key/,
};

export class CredentialFillError extends Error {
  readonly code = 'CREDENTIAL_FILL_FAILED';

  constructor(state: string, origin: string, target: string) {
    super(`credential fill at ${origin} for ${JSON.stringify(target)}: ${state}; the capability must not be retried`);
    this.name = this.code;
  }
}

async function fillProtectedValue(
  s: WSession,
  target: string,
  value: string,
  expectedHint: RegExp,
): Promise<string> {
  const pageUrl = new URL(s.page.url());
  const origin = pageUrl.origin;
  if (!['https:', 'http:'].includes(pageUrl.protocol)) throw new Error('credential fill requires an HTTP(S) origin');
  if (!expectedHint.test(target.toLowerCase())) throw new Error(`[credential_target_description_mismatch] Target ${JSON.stringify(target)} lacks the required field description (${expectedHint.source}); no input was sent`);
  try {
    const result = await fillPage(s, target, value, origin, true);
    return result.startsWith('filled') ? `credential ${result}` : result;
  } catch {
    throw new Error('credential fill failed');
  }
}

// How long a credential field is given to appear before the fill is declined.
// A sign-in page renders its input after load, and a two-step flow puts the
// password on a page that does not exist yet, so "not there this millisecond"
// is not the same answer as "not there".
const CREDENTIAL_FIELD_WAIT_MS = 10_000;

// The marker a declined credential fill returns. Not an error: the capability
// is still unspent, so the field can be filled when it exists.
export const CREDENTIAL_FIELD_ABSENT = 'credential-field-absent';

// Resolve and retain the exact node before redeeming. The old presence probe
// and generic fill used different selectors and could fall back to a visual
// guess after the one-shot capability had already been spent.
async function credentialField(
  page: Page,
  target: string,
  allowedOrigin: string,
): Promise<ElementHandle | null> {
  const observed = await resolveObservedControl(page, target, allowedOrigin);
  if (observed) return observed;
  const explicitSelector = target.trim().match(/^(?:input|textarea)(?:\[[^\]]+\])+/)?.[0];
  const description = explicitSelector ? target.slice(explicitSelector.length) : target;
  const kws = description.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const sels = kws.flatMap(k => ['input', 'textarea', '[contenteditable]'].flatMap(t => [`${t}[name*="${k}"]`, `${t}[placeholder*="${k}" i]`, `${t}[aria-label*="${k}" i]`]));
  if (/\b(email|e-mail)\b/i.test(target)) sels.unshift('input[type="email"], input[name*="mail" i], input[autocomplete*="email" i]');
  if (/password|passcode|secret/i.test(target)) sels.unshift('input[type="password"], input[name*="password" i], input[autocomplete*="current-password" i]');
  const deadline = Date.now() + CREDENTIAL_FIELD_WAIT_MS;
  do {
    const frames = page.frames().filter(frame => new URL(frame.url()).origin === allowedOrigin);
    const queries = explicitSelector ? [explicitSelector] : [null, ...sels];
    for (const selector of queries) {
      const handles: ElementHandle[] = [];
      let selected: ElementHandle | null = null;
      try {
        for (const frame of frames) {
          const locator = selector ? frame.locator(selector) : frame.getByLabel(target, { exact: false });
          handles.push(...await locator.elementHandles());
        }
        for (const handle of handles) {
          if (!await handle.isVisible() || !await handle.isEditable()) continue;
          if (selected) throw new Error(`[credential_target_ambiguous] Multiple editable fields match ${JSON.stringify(target)}; capability not consumed`);
          selected = handle;
        }
        if (selected) {
          handles.splice(handles.indexOf(selected), 1);
          return selected;
        }
      } finally {
        await Promise.all(handles.map(handle => handle.dispose()));
      }
    }
    await delay(100);
  } while (Date.now() < deadline);
  return null;
}

async function fillCredentialNode(page: Page, control: ElementHandle, target: string, origin: string, value: string): Promise<string> {
  if (!value) throw new CredentialFillError('empty credential material', origin, target);
  try {
    const ready = await control.evaluate(element => ({
      connected: element.isConnected, origin: element.ownerDocument?.location.origin,
    }));
    if (!ready.connected || ready.origin !== origin || new URL(page.url()).origin !== origin) {
      throw new CredentialFillError('the bound page or field changed before input', origin, target);
    }
    await humanFill(page, control, value);
    const matches = await control.evaluate((element, expected) =>
      element.isConnected && ('value' in element ? element.value : element.textContent) === expected, value);
    if (!matches) throw new CredentialFillError('the bound field did not retain the credential after typing', origin, target);
    return 'credential filled and verified';
  } catch (error) {
    if (error instanceof CredentialFillError) throw error;
    // Input libraries can include the typed value in their errors. Keep only
    // the exception class at this secret boundary, never its message or stack.
    throw new CredentialFillError(`input or verification failed (${error instanceof Error ? error.name : 'unknown error'})`, origin, target);
  }
}

export async function wsFillCredential(
  s: WSession,
  target: string,
  fieldClass: CredentialFieldClass,
  capability: CapabilityRef,
): Promise<string> {
  // Validate the origin, the field class and the field's EXISTENCE before
  // withCapability: redeeming burns a one-shot capability and materializes the
  // plaintext secret. A bad target, a non-HTTP(S) page, or a field that is not
  // on this page must be refused while no secret exists.
  //
  // The existence check is not fussiness. Google's sign-in puts the password on
  // a second page, so prefilling both at load spent the password capability on
  // a field that could not exist yet, and the agent that reached the password
  // page was then denied for a capability it had never used.
  const page: Page = s.page;
  const pageUrl = new URL(page.url());
  const origin = pageUrl.origin;
  if (!['https:', 'http:'].includes(pageUrl.protocol)) throw new Error('credential fill requires an HTTP(S) origin');
  const expectedHint = CREDENTIAL_FIELD_HINTS[fieldClass];
  if (!expectedHint.test(target.toLowerCase())) throw new Error(`[credential_target_description_mismatch] fill_credential field_class=${fieldClass} requires a target description matching ${expectedHint.source}; received ${JSON.stringify(target)}. The field was not inspected and the capability was not consumed`);
  const control = await credentialField(page, target, origin);
  if (!control) return CREDENTIAL_FIELD_ABSENT;
  try {
    if (!await control.isVisible() || !await control.isEditable()
      || !expectedHint.test((await control.evaluate(describeInputTarget)).toLowerCase())) {
      throw new Error(`[credential_target_description_mismatch] The bound field does not match ${fieldClass}; capability not consumed`);
    }
    const expected = { purpose: 'weles.browser.fill' as const, resource: `origin:${origin}/${fieldClass}` };
    return await withCapability(capability, expected, secret =>
      fillCredentialNode(page, control, target, origin, secret));
  } finally {
    await control.dispose();
  }
}

export async function wsFillIdentity(
  s: WSession,
  target: string,
  field: IdentityField,
  value: string,
): Promise<string> {
  const expectedHints: Record<IdentityField, RegExp> = {
    email: /email|e-mail/,
    password: /password|passcode|secret/,
    username: /username|user name|login/,
    first_name: /first.?name|given.?name/,
    last_name: /last.?name|family.?name|surname/,
    birth_month: /birth.*month|month/,
    birth_day: /birth.*day|day/,
    birth_year: /birth.*year|year/,
  };
  return fillProtectedValue(s, target, value, expectedHints[field]);
}

