declare module '@wisent-ai/weles-client' {
  export type VerifiedReceiptClaims = Readonly<{
    taskId: string;
    organizationId: string;
    origin: string;
    action: string;
    outcome: string;
    evidenceDigest: string;
    keyId: string;
    [claim: string]: unknown;
  }>;

  export function verifyReceipt(
    receipt: unknown,
    keys: Readonly<Record<string, string>> | ReadonlyMap<string, string>,
  ): VerifiedReceiptClaims;
}
