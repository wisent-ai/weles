// Credential and identity fills: the value never reaches the model or the
// log, only the page field the capability was minted for. Split out of
// finalize.ts, which keeps the click, fill and close primitives.
import {
  assertNonCredentialInput,
  withCapability,
} from '../../../utils/capability.js';
import type { CapabilityRef } from '../../../utils/capability.js';
import type { WSession } from '../../wsession.js';
import type { ElementHandle, Page } from 'playwright';
import { fillPage } from './page_fill.js';
import { humanFill } from '../../../human/keyboard.js';
import {
  assertDeclaredControl,
  credentialField,
  type CredentialFieldClass,
} from './credential_field/index.js';

type IdentityField =
  | 'email'
  | 'password'
  | 'username'
  | 'first_name'
  | 'last_name'
  | 'birth_month'
  | 'birth_day'
  | 'birth_year';

/** The run identity fields that are secrets, and the class whose field they need. */
const IDENTITY_SECRETS: Partial<Record<IdentityField, CredentialFieldClass>> = {
  password: 'password',
};

/** Page protocols a credential may be typed into. */
const WEB_PROTOCOLS: Record<string, true> = { 'https:': true, 'http:': true };

function webOrigin(page: Page): string {
  const pageUrl = new URL(page.url());
  if (!Object.hasOwn(WEB_PROTOCOLS, pageUrl.protocol))
    throw new Error(
      `credential fill requires an HTTP(S) origin; the page is ${pageUrl.protocol} (${pageUrl.origin})`,
    );
  return pageUrl.origin;
}

export class CredentialFillError extends Error {
  readonly code = 'CREDENTIAL_FILL_FAILED';

  constructor(state: string, origin: string, target: string) {
    super(
      `credential fill at ${origin} for ${JSON.stringify(target)}: ${state}; the capability must not be retried`,
    );
    this.name = this.code;
  }
}

// The marker a declined credential fill returns. Not an error: the capability
// is still unspent, so the field can be filled once it exists. A sign-in page
// renders its input after load and a two-step flow puts the password on a
// page that does not exist yet; the caller waits for that page (`wait_for`)
// and fills again instead of this lookup polling for it.
export const CREDENTIAL_FIELD_ABSENT = 'credential-field-absent';

async function fillCredentialNode(
  page: Page,
  control: ElementHandle,
  target: string,
  origin: string,
  value: string,
): Promise<string> {
  if (!value)
    throw new CredentialFillError('empty credential material', origin, target);
  try {
    const ready = await control.evaluate((element) => ({
      connected: element.isConnected,
      origin: element.ownerDocument?.location.origin,
    }));
    if (
      !ready.connected ||
      ready.origin !== origin ||
      new URL(page.url()).origin !== origin
    ) {
      throw new CredentialFillError(
        'the bound page or field changed before input',
        origin,
        target,
      );
    }
    await humanFill(page, control, value);
    const matches = await control.evaluate(
      (element, expected) =>
        element.isConnected &&
        ('value' in element ? element.value : element.textContent) === expected,
      value,
    );
    if (!matches)
      throw new CredentialFillError(
        'the bound field did not retain the credential after typing',
        origin,
        target,
      );
    return 'credential filled and verified';
  } catch (error) {
    if (error instanceof CredentialFillError) throw error;
    // Input libraries can include the typed value in their errors. Keep only
    // the exception class at this secret boundary, never its message or stack.
    throw new CredentialFillError(
      `input or verification failed (${error instanceof Error ? error.name : 'unknown error'})`,
      origin,
      target,
    );
  }
}

export async function wsFillCredential(
  s: WSession,
  target: string,
  fieldClass: CredentialFieldClass,
  capability: CapabilityRef,
): Promise<string> {
  // Validate the origin, the field and the field's EXISTENCE before
  // withCapability: redeeming burns a one-shot capability and materializes the
  // plaintext secret. A non-HTTP(S) page, a field that is not on this page, or
  // a field whose markup does not declare the class must be refused while no
  // secret exists.
  //
  // The existence check is not fussiness. Google's sign-in puts the password on
  // a second page, so prefilling both at load spent the password capability on
  // a field that could not exist yet, and the agent that reached the password
  // page was then denied for a capability it had never used.
  const page: Page = s.page;
  const origin = webOrigin(page);
  const control = await credentialField(page, target, origin, fieldClass);
  if (!control) return CREDENTIAL_FIELD_ABSENT;
  try {
    if (!(await control.isVisible()) || !(await control.isEditable()))
      throw new Error(
        `[credential_target_unusable] ${JSON.stringify(target)} is not a visible editable field; capability not consumed`,
      );
    await assertDeclaredControl(control, fieldClass, target);
    const expected = {
      purpose: 'weles.browser.fill' as const,
      resource: `origin:${origin}/${fieldClass}`,
    };
    return await withCapability(capability, expected, (secret) =>
      fillCredentialNode(page, control, target, origin, secret),
    );
  } finally {
    await control.dispose();
  }
}

/**
 * Fills one field from the run's generated identity. A secret identity field
 * (the password) goes through the same declared-markup check as a credential;
 * the others are the persona's own details and are filled by description,
 * never logged.
 */
export async function wsFillIdentity(
  s: WSession,
  target: string,
  field: IdentityField,
  value: string,
): Promise<string> {
  const page: Page = s.page;
  const origin = webOrigin(page);
  const secretClass = IDENTITY_SECRETS[field];
  if (secretClass !== undefined) {
    const control = await credentialField(page, target, origin, secretClass);
    if (!control) return CREDENTIAL_FIELD_ABSENT;
    try {
      await assertDeclaredControl(control, secretClass, target);
      return await fillCredentialNode(page, control, target, origin, value);
    } finally {
      await control.dispose();
    }
  }
  try {
    const result = await fillPage(s, target, value, origin, true);
    return result.startsWith('filled') ? `identity ${result}` : result;
  } catch (error) {
    // The fill error may carry the typed value; only its class leaves here.
    throw new CredentialFillError(
      `identity ${field} input failed (${error instanceof Error ? error.name : typeof error})`,
      origin,
      target,
    );
  }
}
