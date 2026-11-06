import { assertCapability, type CapabilityRef } from '../capability.js';

export type AppleTwoFactorSource = {
  mode: 'capability';
  capability: CapabilityRef;
};

export interface AppleLoginCapabilities {
  email: CapabilityRef;
  password: CapabilityRef;
  two_factor: AppleTwoFactorSource;
}

/** The fields each payload carries, typed against the interfaces above so they cannot drift: never more or fewer. */
const LOGIN_FIELDS: Record<keyof AppleLoginCapabilities, true> = {
  email: true,
  password: true,
  two_factor: true,
};
const TWO_FACTOR_FIELDS: Record<keyof AppleTwoFactorSource, true> = {
  mode: true,
  capability: true,
};

/** A version 1-8 UUID in its text form (RFC 9562, sections 4 and 5): https://www.rfc-editor.org/rfc/rfc9562#section-4 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseObject(input: unknown, what: string): Record<string, unknown> {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      throw new Error(
        `${what} is not JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${what} is not a JSON object`);
  return value as Record<string, unknown>;
}

/** Refuses `record` unless it carries exactly the fields `declared` names. */
function requireExactFields(
  record: Record<string, unknown>,
  declared: Record<string, true>,
  what: string,
) {
  const keys = Object.keys(record).sort();
  const expected = Object.keys(declared).sort();
  if (
    keys.length !== expected.length ||
    expected.some((key, index) => keys[index] !== key)
  ) {
    throw new Error(
      `${what} requires exactly ${expected.join(', ')}; got ${keys.join(', ')}`,
    );
  }
}

function parseCapabilityRef(input: unknown, what: string): CapabilityRef {
  return parseObject(input, what) as unknown as CapabilityRef;
}

export function parseAppleLoginCapabilities(
  input: unknown,
  authorizationId: string,
): AppleLoginCapabilities {
  if (!UUID_PATTERN.test(authorizationId))
    throw new Error(
      `Apple authorization id ${JSON.stringify(authorizationId)} is not a UUID`,
    );
  const record = parseObject(input, 'Apple login capabilities');
  requireExactFields(record, LOGIN_FIELDS, 'Apple login capabilities');

  const email = parseCapabilityRef(record.email, 'the Apple email capability');
  assertCapability(email, {
    purpose: 'weles.browser.fill',
    resource: 'origin:https://idmsa.apple.com/email',
    authorization_id: authorizationId,
  });
  const password = parseCapabilityRef(
    record.password,
    'the Apple password capability',
  );
  assertCapability(password, {
    purpose: 'weles.browser.fill',
    resource: 'origin:https://idmsa.apple.com/password',
    authorization_id: authorizationId,
  });

  const twoFactorRaw = parseObject(
    record.two_factor,
    'the Apple two_factor source',
  );
  requireExactFields(
    twoFactorRaw,
    TWO_FACTOR_FIELDS,
    'Apple 2FA (one authorization-bound capability)',
  );
  if (twoFactorRaw.mode !== 'capability')
    throw new Error(
      `Apple 2FA mode must be capability, got ${JSON.stringify(twoFactorRaw.mode)}`,
    );
  const capability = parseCapabilityRef(
    twoFactorRaw.capability,
    'the Apple 2FA capability',
  );
  assertCapability(capability, {
    purpose: 'weles.apple.2fa',
    resource: `challenge:apple/${authorizationId}`,
    authorization_id: authorizationId,
  });
  return { email, password, two_factor: { mode: 'capability', capability } };
}
