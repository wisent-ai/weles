import { assertCapability, type CapabilityRef } from './capability.js';

export type AppleTwoFactorSource =
  { mode: 'capability'; capability: CapabilityRef };

export interface AppleLoginCapabilities {
  email: CapabilityRef;
  password: CapabilityRef;
  two_factor: AppleTwoFactorSource;
}

const EXPECTED_KEYS = ['email', 'password', 'two_factor'] as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseObject(input: unknown): Record<string, unknown> {
  if (typeof input === 'string') {
    try { input = JSON.parse(input); } catch { throw new Error('invalid Apple login capabilities JSON'); }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid Apple login capabilities');
  return input as Record<string, unknown>;
}

function parseCapabilityRef(input: unknown): CapabilityRef {
  return parseObject(input) as unknown as CapabilityRef;
}

export function parseAppleLoginCapabilities(input: unknown, authorizationId: string): AppleLoginCapabilities {
  if (!UUID_PATTERN.test(authorizationId)) throw new Error('invalid Apple authorization id');
  const record = parseObject(input);
  const keys = Object.keys(record).sort();
  if (keys.length !== EXPECTED_KEYS.length || EXPECTED_KEYS.some((key, index) => keys[index] !== key)) {
    throw new Error('Apple login capabilities require exactly email, password, and two_factor');
  }

  const email = parseCapabilityRef(record.email);
  assertCapability(email, {
    purpose: 'weles.browser.fill',
    resource: 'origin:https://idmsa.apple.com/email',
    authorization_id: authorizationId,
  });
  const password = parseCapabilityRef(record.password);
  assertCapability(password, {
    purpose: 'weles.browser.fill',
    resource: 'origin:https://idmsa.apple.com/password',
    authorization_id: authorizationId,
  });

  const twoFactorRaw = parseObject(record.two_factor);
  const mode = twoFactorRaw.mode;
  if (mode !== 'capability'
      || Object.keys(twoFactorRaw).length !== 2
      || !Object.hasOwn(twoFactorRaw, 'capability')) {
    throw new Error('Apple 2FA requires exactly one authorization-bound capability');
  }
  const capability = parseCapabilityRef(twoFactorRaw.capability);
  assertCapability(capability, {
    purpose: 'weles.apple.2fa',
    resource: `challenge:apple/${authorizationId}`,
    authorization_id: authorizationId,
  });
  return { email, password, two_factor: { mode, capability } };
}
