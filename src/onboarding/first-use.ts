import { createHash } from 'node:crypto';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  JourneyClient,
  StadoJourneyTransport,
  type JourneyProgress,
  type JourneyStorage,
  type JourneyTransport,
} from '../onboarding-runtime';

import { FileJourneyStorage } from './journey-storage.js';
import { OfflineJourneyTransport, VersionPinnedTransport } from './journey-transport.js';
import { loadReceiptVerifier, requireVerifiedClaims, type ReceiptClaims } from './receipt.js';
import {
  CONTENT,
  JOURNEY_ID,
  JOURNEY_VERSION,
  PRODUCT_ID,
  SOURCE_REVISION,
  WELES_FIRST_USE_FALLBACK,
  definition,
  hasPinnedProductSurface,
} from './journey-surface.js';

export { FileJourneyStorage } from './journey-storage.js';
export { WELES_FIRST_USE_FALLBACK } from './journey-surface.js';

const TOKEN_ENVIRONMENT_KEY = 'WELES_STADO_INTEGRATION_TOKEN';
const SHA256 = /^[0-9a-f]{64}$/i;

type OnboardingAction = 'status' | 'next' | 'import' | 'verify' | 'reset';

export type WelesOnboardingInput = {
  action?: OnboardingAction;
  subject?: string;
  stateDirectory?: string;
  receipt?: unknown;
  receiptKeys?: Readonly<Record<string, string>>;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  importReport?: Readonly<{ imported: number; unchanged: number; refused: number }>;
};

export type WelesOnboardingView = {
  product_id: typeof PRODUCT_ID;
  journey_id: typeof JOURNEY_ID;
  journey_version: typeof JOURNEY_VERSION;
  status: JourneyProgress['status'];
  attempt_id: string;
  screen: {
    id: string;
    title: string;
    body: string;
    actions: readonly string[];
  };
  control_plane: 'connected' | 'offline';
  verified_receipt?: {
    task_id: string;
    outcome: string;
    evidence_digest: string;
    key_id: string;
  };
};

function stableSubject(input: WelesOnboardingInput, environment: NodeJS.ProcessEnv): string {
  const subject = input.subject?.trim()
    || environment.WELES_ONBOARDING_SUBJECT?.trim()
    || `${userInfo().username}@${hostname()}`;
  if (!subject || subject.length > 512) throw new Error('onboarding subject must contain 1 to 512 characters');
  return subject;
}

function stateDirectory(input: WelesOnboardingInput, environment: NodeJS.ProcessEnv): string {
  return input.stateDirectory
    || environment.WELES_ONBOARDING_STATE_DIR?.trim()
    || join(homedir(), '.weles', 'onboarding');
}

function render(client: { progress: JourneyProgress | null; screen: { screen_id: string; actions: readonly string[] } | null }, connected: boolean, claims?: ReceiptClaims): WelesOnboardingView {
  if (!client.progress || !client.screen) throw new Error('Weles onboarding did not start');
  const content = CONTENT[client.screen.screen_id];
  if (!content) throw new Error(`Weles has no product content for journey screen ${client.screen.screen_id}`);
  return {
    product_id: PRODUCT_ID,
    journey_id: JOURNEY_ID,
    journey_version: JOURNEY_VERSION,
    status: client.progress.status,
    attempt_id: client.progress.attempt_id,
    screen: {
      id: client.screen.screen_id,
      title: content.title,
      body: content.body,
      actions: client.progress.status === 'completed' ? [] : client.screen.actions,
    },
    control_plane: connected ? 'connected' : 'offline',
    ...(claims ? {
      verified_receipt: {
        task_id: claims.taskId,
        outcome: claims.outcome,
        evidence_digest: claims.evidenceDigest,
        key_id: claims.keyId,
      },
    } : {}),
  };
}

export async function runWelesOnboarding(input: WelesOnboardingInput = {}): Promise<WelesOnboardingView> {
  const action = input.action ?? 'status';
  if (!['status', 'next', 'import', 'verify', 'reset'].includes(action)) throw new Error(`unknown onboarding action: ${action}`);

  const environment = input.environment ?? process.env;
  const subject = stableSubject(input, environment);
  const subjectHash = createHash('sha256').update(subject).digest('hex');
  const baseUrl = environment.STADO_INTEGRATION_API_URL?.trim();
  const rawToken = environment[TOKEN_ENVIRONMENT_KEY];
  const token = rawToken?.trim();
  if (rawToken && (rawToken !== token || /[\u0000-\u001f\u007f]/u.test(rawToken))) {
    throw new Error(`${TOKEN_ENVIRONMENT_KEY} contains invalid whitespace or control characters`);
  }
  const configured = Boolean(baseUrl && token);
  const baseTransport: JourneyTransport = baseUrl && token
    ? new StadoJourneyTransport({
        baseUrl,
        token,
        fetch: input.fetch,
      })
    : new OfflineJourneyTransport();
  const transport = new VersionPinnedTransport(baseTransport, JOURNEY_VERSION, hasPinnedProductSurface);
  const storage = new FileJourneyStorage(stateDirectory(input, environment), hasPinnedProductSurface);
  const client = new JourneyClient({
    productId: PRODUCT_ID,
    journeyId: JOURNEY_ID,
    subjectHash,
    scopeKind: 'device',
    transport,
    storage,
    canonicalFallback: WELES_FIRST_USE_FALLBACK,
  });

  const evidenceRevision = SOURCE_REVISION;
  await client.start(evidenceRevision);
  await client.flush();
  const progress = client.progress;
  if (!progress) throw new Error('Weles onboarding did not create progress');
  const central = configured
    ? await Promise.allSettled([
        transport.readState(PRODUCT_ID, progress.attempt_id, subjectHash),
        transport.assignExperiment({
          product_id: PRODUCT_ID,
          app_id: 'weles',
          platform: 'operator',
          surface: 'operator_cli',
          subject,
        }),
      ])
    : [];
  const connected = configured && central.every((result) => result.status === 'fulfilled');

  if (action === 'reset') {
    await client.reset(evidenceRevision);
    await client.expose(evidenceRevision);
    return render(client, connected);
  }

  if (client.progress?.status === 'completed') return render(client, connected);
  await client.expose(evidenceRevision);

  if (action === 'next') {
    if (client.screen?.screen_id === 'receipt-verification') {
      throw new Error('the receipt-verification step requires a signed service receipt; use onboarding verify');
    }
    const firstAction = client.screen?.screen_id === definition.entry_screen_id
      && !client.progress?.completed_screen_ids.includes(definition.entry_screen_id);
    const decision = await client.advance({}, evidenceRevision);
    if (!decision) throw new Error('the current onboarding step cannot advance');
    if (firstAction) {
      await client.emit('onboarding_first_action_completed', {}, evidenceRevision, decision, definition.entry_screen_id);
    }
    await client.expose(evidenceRevision);
    return render(client, connected);
  }

  if (action === 'import') {
    if (client.screen?.screen_id !== 'existing-data') {
      throw new Error('complete the authorization-boundary step before recording an import');
    }
    const report = input.importReport;
    if (!report
      || !Number.isInteger(report.imported)
      || !Number.isInteger(report.unchanged)
      || !Number.isInteger(report.refused)
      || report.imported < 0
      || report.unchanged < 0
      || report.refused < 0
      || report.imported + report.unchanged === 0) {
      throw new Error('onboarding import requires a persisted Weles import result');
    }
    const decision = await client.advance({ existing_data_imported: true }, evidenceRevision);
    if (!decision) throw new Error('the existing-data onboarding step cannot advance');
    await client.expose(evidenceRevision);
    return render(client, connected);
  }

  if (action === 'verify') {
    if (client.screen?.screen_id !== 'receipt-verification') {
      throw new Error('complete the authorization-boundary and host-execution steps before verifying a receipt');
    }
    if (!input.receipt || !input.receiptKeys || Object.keys(input.receiptKeys).length === 0) {
      throw new Error('receipt verification requires a receipt and trusted public-key map');
    }
    const { verifyReceipt } = await loadReceiptVerifier();
    const claims = requireVerifiedClaims(verifyReceipt(input.receipt, input.receiptKeys));
    if (claims.outcome !== 'completed') {
      throw new Error(`verified receipt outcome is not a completed Weles workflow: ${claims.outcome}`);
    }
    const receiptRevision = SHA256.test(claims.evidenceDigest)
      ? `sha256:${claims.evidenceDigest.toLowerCase()}`
      : `receipt:${createHash('sha256').update(claims.evidenceDigest).digest('hex')}`;
    const completed = await client.complete(
      { authorized_browser_workflow_completed: true },
      receiptRevision,
      {
        task_id: claims.taskId,
        outcome: claims.outcome,
        evidence_digest: claims.evidenceDigest,
        receipt_key_id: claims.keyId,
      },
    );
    if (!completed) throw new Error('verified receipt did not satisfy the Weles first-success contract');
    await client.observeFirstSuccess(
      { authorized_browser_workflow_completed: true },
      receiptRevision,
      {
        task_id: claims.taskId,
        outcome: claims.outcome,
        evidence_digest: claims.evidenceDigest,
        receipt_key_id: claims.keyId,
      },
    );
    return render(client, connected, claims);
  }

  return render(client, connected);
}
