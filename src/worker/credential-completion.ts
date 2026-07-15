export type CredentialTransfer = {
  secretValue: string | null;
  error: string | null;
};

type CompletionCallbacks = {
  completed: (safeResult: Record<string, unknown>) => Promise<void>;
  failed: (safeResult: Record<string, unknown>, error: string) => Promise<void>;
};

export type PreparedCredentialCompletion = {
  safeResult: Record<string, unknown>;
  transfer: CredentialTransfer;
  allowArtifactPersistence: boolean;
};

function redactValue(value: unknown, secret: string): unknown {
  if (typeof value === 'string') return value.includes(secret) ? value.split(secret).join('[REDACTED]') : value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secret));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redactValue(item, secret)]),
    );
  }
  return value;
}

export function redactCredentialResult(result: Record<string, unknown>, secret: string | null): Record<string, unknown> {
  if (!secret) return result;
  return redactValue(result, secret) as Record<string, unknown>;
}

export async function prepareCredentialCompletion(
  result: Record<string, unknown>,
  skarbiecTarget: boolean,
  transfer: () => Promise<CredentialTransfer>,
): Promise<PreparedCredentialCompletion> {
  if (!skarbiecTarget) {
    return {
      safeResult: result,
      transfer: { secretValue: null, error: null },
      allowArtifactPersistence: true,
    };
  }
  const transferred = await transfer();
  return {
    safeResult: redactCredentialResult(result, transferred.secretValue),
    transfer: transferred,
    allowArtifactPersistence: false,
  };
}

export async function finalizeCredentialCompletion(
  prepared: PreparedCredentialCompletion,
  callbacks: CompletionCallbacks,
): Promise<'completed' | 'failed'> {
  if (prepared.transfer.error) {
    await callbacks.failed(prepared.safeResult, prepared.transfer.error);
    return 'failed';
  }
  await callbacks.completed(prepared.safeResult);
  return 'completed';
}
