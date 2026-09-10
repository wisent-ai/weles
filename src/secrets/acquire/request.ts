// What a caller may ask of Weles about a credential, and every answer it can
// get back.
//
// This is the whole external vocabulary of secret acquisition and the only part
// of it the rest of the repository sees: `src/index.ts` re-exports these three
// names and nothing else from the acquisition tree. It changes when the promise
// to callers changes, which is a slower and more consequential event than any
// change to how a job is queued, so it is stated once, apart from the code that
// produces it.
//
// AcquireSecretResult is a discriminated union rather than one loose shape
// because each outcome carries different evidence: a queued operation names the
// action log row that will do the work, a refusal names what is missing or what
// is unsupported, and a plan carries the payload that would have been queued.
// Widening any of them widens what a credential path is allowed to promise.

export type CredentialOperation = 'acquire' | 'adopt' | 'rotate' | 'verify' | 'remove' | 'reset';

export type AcquireSecretRequest = {
  operation?: CredentialOperation;
  credentialId?: string;
  provider?: string;
  requestId?: string;
  goal?: string;
  secret?: string;
  purpose?: string;
  dryRun?: boolean;
  autoPromoteTrajectory?: boolean;
  proxy?: string;
  headless?: boolean;
  priority?: number;
  tenantId?: string | null;
  accountEmail?: string;
  accountUpn?: string;
  principalObjectId?: string;
  signupOrigin?: string;
};

export type AcquireSecretResult =
  | {
      status: 'operation_plan';
      operation: CredentialOperation;
      secret: string;
      provider: string;
      vaultItemId: string;
      url: string;
      objective: string;
      params: Record<string, unknown>;
    }
  | {
      status: 'operation_queued';
      operation: 'acquire';
      secret: string;
      provider: string;
      buildId: string;
      actionLogId: string;
      action: 'generic_keeper_task';
      flowName: string;
      message: string;
      vaultItemId?: string;
    }
  | {
      status: 'operation_queued';
      operation: 'acquire';
      vaultItemId: string;
      secret: string;
      provider: string;
      sourceActionLogId: string;
      actionLogId: string;
      action: 'semanticscholar_key_followup';
      flowName: 'semantic-scholar-key-followup';
      scheduledAt?: string;
      alreadyQueued: boolean;
      message: string;
    }
  | {
      status: 'operation_queued';
      operation: 'adopt' | 'rotate' | 'verify';
      secret: string;
      provider: 'microsoft';
      actionLogId: string;
      action: 'microsoft_adopt_password' | 'microsoft_reset_password' | 'microsoft_verify_password';
      flowName: 'microsoft-password-lifecycle';
      vaultItemId: string;
      message: string;
    }
  | {
      status: 'operation_queued';
      operation: 'adopt' | 'rotate' | 'verify' | 'reset';
      secret: string;
      provider: 'microsoft_entra';
      actionLogId: string;
      action: 'microsoft_entra_adopt_password' | 'microsoft_entra_reset_password' | 'microsoft_entra_verify_password';
      flowName: 'microsoft-entra-password-lifecycle';
      vaultItemId: string;
      message: string;
    }
  | {
      status: 'followup_queued';
      secret: string;
      provider: string;
      sourceActionLogId: string;
      actionLogId?: string;
      action: 'semanticscholar_key_followup';
      flowName: 'semantic-scholar-key-followup';
      scheduledAt?: string;
      alreadyQueued: boolean;
      message: string;
    }
  | {
      status: 'needs_configuration';
      operation?: CredentialOperation;
      secret: string;
      provider: string;
      vaultItemId: string;
      missing: string[];
      message: string;
    }
  | {
      status: 'unsupported_operation';
      operation: CredentialOperation;
      secret: string;
      provider: string;
      message: string;
    }
  | {
      status: 'unsupported_secret';
      operation?: CredentialOperation;
      secret: string;
      message: string;
    };
