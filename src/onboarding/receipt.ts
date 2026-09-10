// The Weles receipt a first-use run verifies: the official verifier, loaded
// across the module boundary, and the claims a verified receipt must carry.

export type ReceiptClaims = {
  taskId: string;
  organizationId: string;
  origin: string;
  action: string;
  outcome: string;
  evidenceDigest: string;
  keyId: string;
};

export async function loadReceiptVerifier(): Promise<{
  verifyReceipt(receipt: unknown, keys: Readonly<Record<string, string>>): unknown;
}> {
  // The official receipt verifier is ESM-only while the Weles CLI is CommonJS, so it must cross the module boundary asynchronously.
  return await import('@wisent-ai/weles-client');
}

function requiredStringProperty(value: object, field: string): string {
  if (!(field in value)) throw new Error(`verified receipt claim ${field} is missing`);
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  const candidate = descriptor?.value;
  if (typeof candidate !== 'string' || !candidate.trim()) {
    throw new Error(`verified receipt claim ${field} is missing`);
  }
  return candidate;
}

export function requireVerifiedClaims(value: unknown): ReceiptClaims {
  if (!value || typeof value !== 'object') throw new Error('verified receipt claims are invalid');
  return {
    taskId: requiredStringProperty(value, 'taskId'),
    organizationId: requiredStringProperty(value, 'organizationId'),
    origin: requiredStringProperty(value, 'origin'),
    action: requiredStringProperty(value, 'action'),
    outcome: requiredStringProperty(value, 'outcome'),
    evidenceDigest: requiredStringProperty(value, 'evidenceDigest'),
    keyId: requiredStringProperty(value, 'keyId'),
  };
}
