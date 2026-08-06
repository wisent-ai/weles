const SENSITIVE_ENV_KEY = /(?:PASSWORD|PASSCODE|SECRET|TOKEN|CAPABILIT|PRIVATE_KEY|SERVICE_ROLE|API_KEY|AUTHORIZATION|COOKIE|SESSION_KEY|DATABASE_URL|DB_URL|PROXY_URL|APPLE_2FA_CODE$|(?:^|_)KEY$)/i;

export function snapshotSanitizedEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value !== 'string') continue;
    snapshot[key] = SENSITIVE_ENV_KEY.test(key) ? '[REDACTED]' : value;
  }
  return snapshot;
}
