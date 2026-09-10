// Credential and identity fills: the value never reaches the model or the
// log, only the page field the capability was minted for. Split out of
// finalize.ts, which keeps the click, fill and close primitives.
import { assertNonCredentialInput, withCapability } from '../../../utils/capability.js';
import type { CapabilityRef } from '../../../utils/capability.js';
import type { WSession } from '../../wsession.js';
import { childFrames, fillPage, firstVisible } from '../finalize.js';

type CredentialFieldClass = 'password' | 'email' | 'username' | 'token' | 'api-key';
type IdentityField = 'email' | 'password' | 'username' | 'first_name' | 'last_name' | 'birth_month' | 'birth_day' | 'birth_year';

const CREDENTIAL_FIELD_HINTS: Record<CredentialFieldClass, RegExp> = {
  password: /password|passcode|secret/,
  email: /email|e-mail/,
  username: /username|user name|login/,
  token: /token|verification code|one-time code|otp/,
  'api-key': /api.?key|access key/,
};

async function fillProtectedValue(
  s: WSession,
  target: string,
  value: string,
  expectedHint: RegExp,
): Promise<string> {
  const pageUrl = new URL(s.page.url());
  const origin = pageUrl.origin;
  if (!['https:', 'http:'].includes(pageUrl.protocol)) throw new Error('credential fill requires an HTTP(S) origin');
  if (!expectedHint.test(target.toLowerCase())) throw new Error('credential field class mismatch');
  try {
    const result = await fillPage(s, target, value, origin);
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

// Does a field this fill could land in exist yet? The locator half of
// `fillPage`, run before anything is redeemed. A false negative costs only a
// prefill the agent can still do itself; a false positive costs a burnt
// one-shot capability and a plaintext secret with nowhere to go.
async function credentialFieldPresent(
  s: WSession,
  target: string,
  allowedOrigin: string,
): Promise<boolean> {
  const explicitSelector = target.trim().match(/^(?:input|textarea)(?:\[[^\]]+\])+/)?.[0];
  const description = explicitSelector ? target.slice(explicitSelector.length) : target;
  const kws = description.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const sels = kws.flatMap(k => ['input', 'textarea', '[contenteditable]'].flatMap(t => [`${t}[name*="${k}"]`, `${t}[placeholder*="${k}" i]`, `${t}[aria-label*="${k}" i]`]));
  if (/\b(email|e-mail)\b/i.test(target)) {
    sels.unshift('input[type="email"], input[name*="email" i], input[name*="mail" i], input[autocomplete*="email" i]');
  }
  if (/password|passcode|secret/i.test(target)) {
    sels.unshift('input[type="password"], input[name*="password" i], input[autocomplete*="current-password" i]');
  }
  if (explicitSelector) sels.unshift(explicitSelector);
  const deadline = Date.now() + CREDENTIAL_FIELD_WAIT_MS;
  do {
    for (const frame of childFrames(s, allowedOrigin)) {
      try { if (await firstVisible(frame.getByLabel?.(target, { exact: false }))) return true; } catch {}
      for (const sel of sels) {
        try { if (await firstVisible(frame.locator?.(sel))) return true; } catch {}
      }
    }
    try { if (await firstVisible(s.page.getByLabel?.(target, { exact: false }))) return true; } catch {}
    for (const sel of sels) {
      try { if (await firstVisible(s.page.locator?.(sel))) return true; } catch {}
    }
  } while (Date.now() < deadline);
  return false;
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
  const pageUrl = new URL(s.page.url());
  const origin = pageUrl.origin;
  if (!['https:', 'http:'].includes(pageUrl.protocol)) throw new Error('credential fill requires an HTTP(S) origin');
  const expectedHint = CREDENTIAL_FIELD_HINTS[fieldClass];
  if (!expectedHint.test(target.toLowerCase())) throw new Error('credential field class mismatch');
  if (!await credentialFieldPresent(s, target, origin)) return CREDENTIAL_FIELD_ABSENT;
  const expected = { purpose: 'weles.browser.fill' as const, resource: `origin:${origin}/${fieldClass}` };
  return withCapability(capability, expected, (secret) =>
    fillProtectedValue(s, target, secret, expectedHint));
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

