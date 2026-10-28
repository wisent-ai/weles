import { createHash } from 'node:crypto';
import {
  CAPABILITY_RE,
  CapabilityPendingError,
  UUID_RE,
  requestCapability,
} from './capability/broker.js';

export { CapabilityPendingError } from './capability/broker.js';

export type WelesCapabilityPurpose =
  | 'weles.browser.fill'
  | 'weles.captcha.solve'
  | 'weles.sms.verify'
  | 'weles.apple.2fa'
  | 'weles.proxy.authenticate'
  | 'weles.brama.sign';

export interface CapabilityRef {
  capability_id: string;
  purpose: WelesCapabilityPurpose;
  resource: string;
  target: 'weles';
  authorization_id?: string;
}

export interface CapabilityExpectation {
  purpose: WelesCapabilityPurpose;
  resource: string;
  authorization_id?: string;
}

const RESOURCE_PREFIXES: Readonly<
  Record<WelesCapabilityPurpose, readonly string[]>
> = {
  'weles.browser.fill': ['origin:', 'challenge:apple/'],
  'weles.captcha.solve': ['provider:'],
  'weles.sms.verify': ['provider:'],
  'weles.apple.2fa': ['challenge:apple/'],
  'weles.proxy.authenticate': ['proxy:'],
  'weles.brama.sign': ['brama:', 'agent:'],
};

function validResource(
  purpose: WelesCapabilityPurpose,
  resource: string,
): boolean {
  if (
    typeof resource !== 'string' ||
    resource.trim() !== resource ||
    /[*\u0000\r\n]/.test(resource)
  )
    return false;
  return (
    Object.hasOwn(RESOURCE_PREFIXES, purpose) &&
    RESOURCE_PREFIXES[purpose].some(
      (prefix) =>
        resource.startsWith(prefix) && resource.length > prefix.length,
    )
  );
}

/**
 * The SHA-256 digests of the secret material capabilities redeemed in this
 * process. The material itself is wiped after use; its digest is kept so a
 * literal equal to it, a secret the model saw on a page typed back, is
 * refused wherever it would go.
 */
const REDEEMED = new Set<string>();

function digestOf(material: Buffer): string {
  return createHash('sha256').update(material).digest('hex');
}

/**
 * Refuses a literal that names an environment variable instead of stating a
 * value, or that equals secret material a capability redeemed in this
 * process. Whether the field it goes into may take a literal at all is the
 * field's own markup to answer (`assertLiteralControl`), never words of the
 * target or the shape of the value.
 */
export function assertNonCredentialInput(value: string): string {
  if (/\$\{?[A-Za-z_]\w*\}?/.test(value)) {
    throw new Error(
      'environment references are forbidden in model input; use a capability reference',
    );
  }
  if (REDEEMED.has(digestOf(Buffer.from(value, 'utf8')))) {
    throw new Error(
      '[credential_literal] the literal equals secret material a capability redeemed in this process; credential fields require fill_credential with a capability reference',
    );
  }
  return value;
}

/** What a buffer that held secret material is overwritten with: NUL bytes. */
const WIPED = '\0';

export function assertCapability(
  ref: CapabilityRef,
  expected: CapabilityExpectation,
): string {
  if (
    !ref ||
    typeof ref !== 'object' ||
    Array.isArray(ref) ||
    Object.keys(ref).some(
      (key) =>
        ![
          'capability_id',
          'purpose',
          'resource',
          'target',
          'authorization_id',
        ].includes(key),
    ) ||
    !CAPABILITY_RE.test(ref.capability_id) ||
    ref.target !== 'weles' ||
    !validResource(ref.purpose, ref.resource) ||
    (ref.authorization_id !== undefined && !UUID_RE.test(ref.authorization_id))
  ) {
    throw new Error('invalid capability reference');
  }
  if (
    !validResource(expected.purpose, expected.resource) ||
    ref.purpose !== expected.purpose ||
    ref.resource !== expected.resource ||
    ref.authorization_id !== expected.authorization_id
  ) {
    throw new Error('capability operation mismatch');
  }
  return ref.capability_id;
}

export function assertProviderCapability(
  ref: CapabilityRef,
  purpose: 'weles.captcha.solve' | 'weles.sms.verify',
): { id: string; provider: string } {
  if (
    !ref?.resource?.startsWith('provider:') ||
    ref.resource.length <= 'provider:'.length
  )
    throw new Error('invalid provider capability resource');
  const provider = ref.resource.slice('provider:'.length);
  return {
    id: assertCapability(ref, { purpose, resource: ref.resource }),
    provider,
  };
}

export async function redeemCapability(
  capabilityId: string,
  authorizationId?: string,
): Promise<Buffer> {
  const material = await requestCapability(
    capabilityId,
    'redeem',
    authorizationId,
  );
  REDEEMED.add(digestOf(material));
  return material;
}

export async function cancelCapability(
  capabilityId: string,
  authorizationId?: string,
): Promise<void> {
  const body = await requestCapability(capabilityId, 'cancel', authorizationId);
  try {
    if (body.length)
      throw new Error('capability cancellation returned secret material');
  } finally {
    body.fill(WIPED);
  }
}

export async function withCapability<T>(
  ref: CapabilityRef,
  expected: CapabilityExpectation,
  consume: (secret: string) => Promise<T>,
): Promise<T> {
  const capabilityId = assertCapability(ref, expected);
  const bytes = await redeemCapability(capabilityId, ref.authorization_id);
  let text = '';
  try {
    text = bytes.toString('utf8');
    return await consume(text);
  } finally {
    text = '';
    bytes.fill(WIPED);
  }
}
