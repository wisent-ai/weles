export interface StripeExpireSecretKeyPlan {
  scope: 'single_key';
  expected_fingerprint: string;
  provider_account_id: string;
  incident_reference: string;
  incident_justification: string;
  confirm_expire: true;
}

const SHA256_FINGERPRINT = /^[a-f0-9]{64}$/;
const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9]{8,}$/;
const INCIDENT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,159}$/;

function requiredText(params: Record<string, unknown>, field: string): string {
  const value = params[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`stripe_expire_secret_key requires ${field}`);
  }
  return value.trim();
}

export function parseStripeExpireSecretKeyParams(
  params: Record<string, unknown>,
): StripeExpireSecretKeyPlan {
  if (params.scope !== 'single_key') {
    throw new Error('stripe_expire_secret_key requires scope=single_key');
  }
  const expectedFingerprint = requiredText(params, 'expected_fingerprint');
  if (!SHA256_FINGERPRINT.test(expectedFingerprint)) {
    throw new Error('stripe_expire_secret_key requires a lowercase SHA-256 expected_fingerprint');
  }
  const providerAccountId = requiredText(params, 'provider_account_id');
  if (!STRIPE_ACCOUNT_ID.test(providerAccountId)) {
    throw new Error('stripe_expire_secret_key requires an exact Stripe provider_account_id');
  }
  const incidentReference = requiredText(params, 'incident_reference');
  if (!INCIDENT_REFERENCE.test(incidentReference)) {
    throw new Error('stripe_expire_secret_key requires a stable non-secret incident_reference');
  }
  const incidentJustification = requiredText(params, 'incident_justification');
  if (incidentJustification.length < 24 || incidentJustification.length > 500
      || !/incident/i.test(incidentJustification)
      || !/(compromis|expos|leak)/i.test(incidentJustification)) {
    throw new Error('stripe_expire_secret_key requires an explicit incident-remediation justification');
  }
  if (params.confirm_expire !== true) {
    throw new Error('stripe_expire_secret_key requires confirm_expire=true');
  }
  return {
    scope: 'single_key',
    expected_fingerprint: expectedFingerprint,
    provider_account_id: providerAccountId,
    incident_reference: incidentReference,
    incident_justification: incidentJustification,
    confirm_expire: true,
  };
}
