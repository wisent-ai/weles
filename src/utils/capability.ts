import { setTimeout as delay } from 'node:timers/promises';
import { CAPABILITY_RE, CapabilityPendingError, UUID_RE, requestCapability } from './capability/broker.js';

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

export interface CapabilityPendingRetryOptions {
  timeoutMs?: number;
  intervalMs?: number;
}

const RESOURCE_PREFIXES: Readonly<Record<WelesCapabilityPurpose, readonly string[]>> = {
  'weles.browser.fill': ['origin:', 'challenge:apple/'],
  'weles.captcha.solve': ['provider:'],
  'weles.sms.verify': ['provider:'],
  'weles.apple.2fa': ['challenge:apple/'],
  'weles.proxy.authenticate': ['proxy:'],
  'weles.brama.sign': ['brama:', 'agent:'],
};

function validResource(purpose: WelesCapabilityPurpose, resource: string): boolean {
  if (typeof resource !== 'string' || resource.trim() !== resource || /[*\u0000\r\n]/.test(resource)) return false;
  return RESOURCE_PREFIXES[purpose]?.some((prefix) => resource.startsWith(prefix) && resource.length > prefix.length) ?? false;
}
const CREDENTIAL_TARGET_RE = /\b(password|passcode|secret|token|api[\s_-]*key|access[\s_-]*key|credential|verification[\s_-]*code|otp|username|user[\s_-]*name|e-?mail|login)\b/i;
const SECRET_PREFIX_RE = /^(?:sk|pk|ghp|gho|github_pat|xox[baprs]|eyJ)[-_A-Za-z0-9.]+$/;

export function assertNonCredentialInput(value: string, target?: string): string {
  if (/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/.test(value)) {
    throw new Error('environment references are forbidden in model input; use a capability reference');
  }
  if (target && CREDENTIAL_TARGET_RE.test(target)) {
    throw new Error('credential fields require fill_credential with a capability reference');
  }
  const compactSecret = value.length >= 20 && !/\s/.test(value) && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
  if (compactSecret || SECRET_PREFIX_RE.test(value)) {
    throw new Error('secret-shaped values require fill_credential with a capability reference');
  }
  return value;
}

export function assertCapability(ref: CapabilityRef, expected: CapabilityExpectation): string {
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)
    || Object.keys(ref).some((key) => !['capability_id', 'purpose', 'resource', 'target', 'authorization_id'].includes(key))
    || !CAPABILITY_RE.test(ref.capability_id)
    || ref.target !== 'weles'
    || !validResource(ref.purpose, ref.resource)
    || (ref.authorization_id !== undefined && !UUID_RE.test(ref.authorization_id))) {
    throw new Error('invalid capability reference');
  }
  if (!validResource(expected.purpose, expected.resource)
    || ref.purpose !== expected.purpose
    || ref.resource !== expected.resource
    || ref.authorization_id !== expected.authorization_id) {
    throw new Error('capability operation mismatch');
  }
  return ref.capability_id;
}

export function assertProviderCapability(
  ref: CapabilityRef,
  purpose: 'weles.captcha.solve' | 'weles.sms.verify',
): { id: string; provider: string } {
  if (!ref?.resource?.startsWith('provider:') || ref.resource.length <= 'provider:'.length) throw new Error('invalid provider capability resource');
  const provider = ref.resource.slice('provider:'.length);
  return { id: assertCapability(ref, { purpose, resource: ref.resource }), provider };
}

export async function redeemCapability(capabilityId: string, authorizationId?: string): Promise<Buffer> {
  return requestCapability(capabilityId, 'redeem', authorizationId);
}

export async function cancelCapability(capabilityId: string, authorizationId?: string): Promise<void> {
  const body = await requestCapability(capabilityId, 'cancel', authorizationId);
  try {
    if (body.length !== 0) throw new Error('capability cancellation returned secret material');
  } finally {
    body.fill(0);
  }
}

export async function redeemCapabilityWithPendingRetry(
  capabilityId: string,
  options: CapabilityPendingRetryOptions = {},
  authorizationId?: string,
): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const intervalMs = options.intervalMs ?? 1_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new Error('capability pending timeout must be an integer from 1 to 120000 milliseconds');
  }
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 10 || intervalMs > 5_000) {
    throw new Error('capability pending interval must be an integer from 10 to 5000 milliseconds');
  }

  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await redeemCapability(capabilityId, authorizationId);
    } catch (error) {
      if (!(error instanceof CapabilityPendingError)) throw error;
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new CapabilityPendingError('capability material remained pending until the retry deadline');
      }
      await delay(Math.min(intervalMs, remainingMs));
    }
  }
}

export async function withCapability<T>(ref: CapabilityRef, expected: CapabilityExpectation, consume: (secret: string) => Promise<T>): Promise<T> {
  const capabilityId = assertCapability(ref, expected);
  const bytes = await redeemCapability(capabilityId, ref.authorization_id);
  let text = '';
  try {
    text = bytes.toString('utf8');
    return await consume(text);
  } finally {
    text = '';
    bytes.fill(0);
  }
}

export async function withCapabilityPendingRetry<T>(
  ref: CapabilityRef,
  expected: CapabilityExpectation,
  consume: (secret: string) => Promise<T>,
  options: CapabilityPendingRetryOptions = {},
): Promise<T> {
  const bytes = await redeemCapabilityWithPendingRetry(assertCapability(ref, expected), options, ref.authorization_id);
  let text = '';
  try {
    text = bytes.toString('utf8');
    return await consume(text);
  } finally {
    text = '';
    bytes.fill(0);
  }
}
