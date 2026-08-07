import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import journeyDefinition from './onboarding/journeys/weles-first-use-2026-08-04.1.json';
import {
  JourneyClient,
  StadoJourneyTransport,
  type JourneyAssignment,
  type JourneyAssignmentInput,
  type JourneyBundle,
  type JourneyDefinition,
  type JourneyProgress,
  type JourneyRuntimeEvent,
  type JourneyStorage,
  type JourneyTransport,
} from './onboarding-runtime';

const PRODUCT_ID = 'weles';
const JOURNEY_ID = 'first-use';
const JOURNEY_VERSION = '2026-08-04.1';
const JOURNEY_VERSION_ID = '3a2ba59e-8a7e-4da4-9a76-bb4abf286e6d';
const SOURCE_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const TOKEN_ENVIRONMENT_KEY = 'WELES_STADO_INTEGRATION_TOKEN';
const SHA256 = /^[0-9a-f]{64}$/i;

type OnboardingAction = 'status' | 'next' | 'verify' | 'reset';

type ReceiptClaims = {
  taskId: string;
  organizationId: string;
  origin: string;
  action: string;
  outcome: string;
  evidenceDigest: string;
  keyId: string;
};

export type WelesOnboardingInput = {
  action?: OnboardingAction;
  subject?: string;
  stateDirectory?: string;
  receipt?: unknown;
  receiptKeys?: Readonly<Record<string, string>>;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
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

const definition = journeyDefinition as unknown as JourneyDefinition;
if (definition.product_id !== PRODUCT_ID
  || definition.journey_id !== JOURNEY_ID
  || definition.journey_version !== JOURNEY_VERSION
  || !SOURCE_REVISION_PATTERN.test(definition.source_revision)) {
  throw new Error('bundled Weles first-use journey identity is invalid');
}
const SOURCE_REVISION = definition.source_revision;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}

const canonicalDefinition = JSON.stringify(canonicalize(definition));
export const WELES_FIRST_USE_FALLBACK: JourneyBundle = {
  journey_version_id: JOURNEY_VERSION_ID,
  definition,
  canonical_definition: canonicalDefinition,
  content_sha256: createHash('sha256').update(canonicalDefinition).digest('hex'),
  source_revision: SOURCE_REVISION,
};

const CONTENT: Readonly<Record<string, Readonly<{ title: string; body: string }>>> = {
  'authorization-boundary': {
    title: 'Confirm the authorization boundary',
    body: 'Weles executes only an already-authorized, allowlisted workflow. Possessing credentials does not authorize a new origin or action; organization, origin, action, credential references, justification, idempotency, and evidence policy must be admitted through the safe Weles client before this host runs anything.',
  },
  'host-execution': {
    title: 'Run on the approved Weles host',
    body: 'The scheduler owns task admission and terminal state, the supervised host runs the reviewed trajectory with deployment-selected browsers, and the secret boundary resolves only scoped credential references. Do not start browser automation from onboarding; submit the real approved workflow through @wisent-ai/weles-client and wait for its terminal service response.',
  },
  'receipt-verification': {
    title: 'Verify the real workflow receipt',
    body: 'Export the terminal service receipt and the trusted public-key map, then run: weles onboarding verify --receipt <receipt.json> --keys <receipt-keys.json>. Weles completes first use only after @wisent-ai/weles-client verifies the signature and bound task, organization, origin, action, outcome, and evidence digest.',
  },
};

class OfflineJourneyTransport implements JourneyTransport {
  async readBundle(): Promise<JourneyBundle> { throw new Error('Stado onboarding is offline'); }
  async readState(): Promise<null> { throw new Error('Stado onboarding is offline'); }
  async collectEvent(): Promise<void> { throw new Error('Stado onboarding is offline'); }
  async assignExperiment(_input: JourneyAssignmentInput): Promise<JourneyAssignment> {
    throw new Error('Stado onboarding is offline');
  }
}

class VersionPinnedTransport implements JourneyTransport {
  constructor(private readonly transport: JourneyTransport) {}

  async readBundle(productId: string, journeyId: string): Promise<JourneyBundle> {
    const bundle = await this.transport.readBundle(productId, journeyId, JOURNEY_VERSION);
    if (!isStoredBundle(bundle)) throw new Error('central Weles journey bundle is malformed');
    const screenIds = bundle.definition.screens.map((screen) => screen.screen_id).sort();
    const expectedScreenIds = Object.keys(CONTENT).sort();
    const productSurfaceMatches = screenIds.length === expectedScreenIds.length
      && screenIds.every((screenId, index) => screenId === expectedScreenIds[index])
      && bundle.definition.screens.every((screen) => {
        const expectedAction = screen.screen_id === 'receipt-verification' ? 'verify' : 'next';
        return screen.actions.length === 1 && screen.actions[0] === expectedAction;
      });
    if (bundle.definition.journey_version !== JOURNEY_VERSION
      || bundle.definition.first_success_fact !== 'authorized_browser_workflow_completed'
      || bundle.definition.entry_screen_id !== definition.entry_screen_id
      || !productSurfaceMatches) {
      throw new Error('central Weles journey identity or product surface is invalid');
    }
    return bundle;
  }

  readState(productId: string, attemptId: string, subjectHash: string): Promise<unknown | null> {
    return this.transport.readState(productId, attemptId, subjectHash);
  }

  collectEvent(event: JourneyRuntimeEvent): Promise<void> {
    return this.transport.collectEvent(event);
  }

  assignExperiment(input: JourneyAssignmentInput): Promise<JourneyAssignment> {
    return this.transport.assignExperiment(input);
  }
}

function storedProperty(value: unknown, field: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}

function isStoredBundle(value: unknown): value is JourneyBundle {
  const storedDefinition = storedProperty(value, 'definition');
  const screens = storedProperty(storedDefinition, 'screens');
  return typeof storedProperty(value, 'journey_version_id') === 'string'
    && typeof storedProperty(value, 'canonical_definition') === 'string'
    && typeof storedProperty(value, 'content_sha256') === 'string'
    && typeof storedProperty(value, 'source_revision') === 'string'
    && storedProperty(storedDefinition, 'schema_version') === 1
    && typeof storedProperty(storedDefinition, 'product_id') === 'string'
    && typeof storedProperty(storedDefinition, 'journey_id') === 'string'
    && Array.isArray(screens)
    && screens.every((screen) => typeof storedProperty(screen, 'screen_id') === 'string'
      && Array.isArray(storedProperty(screen, 'actions'))
      && Array.isArray(storedProperty(screen, 'transitions')));
}

function isStoredProgress(value: unknown): value is JourneyProgress {
  const scopeKind = storedProperty(value, 'scope_kind');
  const status = storedProperty(value, 'status');
  const completedScreenIds = storedProperty(value, 'completed_screen_ids');
  const answers = storedProperty(value, 'answers');
  return typeof storedProperty(value, 'attempt_id') === 'string'
    && typeof storedProperty(value, 'product_id') === 'string'
    && typeof storedProperty(value, 'journey_version_id') === 'string'
    && typeof storedProperty(value, 'subject_hash') === 'string'
    && (scopeKind === 'user' || scopeKind === 'organization' || scopeKind === 'device' || scopeKind === 'workload')
    && typeof storedProperty(value, 'current_screen_id') === 'string'
    && Array.isArray(completedScreenIds)
    && completedScreenIds.every((screenId) => typeof screenId === 'string')
    && (status === 'in_progress' || status === 'skipped' || status === 'completed'
      || status === 'abandoned' || status === 'reset')
    && typeof storedProperty(value, 'evidence_revision') === 'string'
    && Array.isArray(answers);
}

function isStoredEvent(value: unknown): value is JourneyRuntimeEvent {
  const properties = storedProperty(value, 'properties');
  return typeof storedProperty(value, 'event_id') === 'string'
    && typeof storedProperty(value, 'event_name') === 'string'
    && typeof storedProperty(value, 'attempt_id') === 'string'
    && typeof storedProperty(value, 'product_id') === 'string'
    && typeof storedProperty(value, 'journey_version_id') === 'string'
    && typeof storedProperty(value, 'subject_hash') === 'string'
    && typeof storedProperty(value, 'screen_id') === 'string'
    && typeof storedProperty(value, 'occurred_at') === 'string'
    && typeof storedProperty(value, 'evidence_revision') === 'string'
    && properties !== null && typeof properties === 'object' && !Array.isArray(properties)
    && Array.isArray(storedProperty(value, 'answers'));
}

export class FileJourneyStorage implements JourneyStorage {
  constructor(private readonly directory: string) {}

  private bundlePath(productId: string, journeyId: string): string {
    return join(this.directory, `${productId}-${journeyId}-bundle.json`);
  }

  private progressPath(productId: string, journeyId: string, subjectHash: string): string {
    return join(this.directory, `${productId}-${journeyId}-${subjectHash}-progress.json`);
  }

  private eventsPath(): string {
    return join(this.directory, 'events.json');
  }

  private async load(path: string): Promise<unknown | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
      return parsed;
    } catch {
      return null;
    }
  }

  private async save(path: string, value: unknown): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }

  async loadBundle(productId: string, journeyId: string): Promise<JourneyBundle | null> {
    const bundle = await this.load(this.bundlePath(productId, journeyId));
    return isStoredBundle(bundle) ? bundle : null;
  }

  saveBundle(bundle: JourneyBundle): Promise<void> {
    return this.save(this.bundlePath(bundle.definition.product_id, bundle.definition.journey_id), bundle);
  }

  async loadProgress(productId: string, journeyId: string, subjectHash: string): Promise<JourneyProgress | null> {
    const progress = await this.load(this.progressPath(productId, journeyId, subjectHash));
    return isStoredProgress(progress) ? progress : null;
  }

  saveProgress(productId: string, journeyId: string, progress: JourneyProgress): Promise<void> {
    return this.save(this.progressPath(productId, journeyId, progress.subject_hash), progress);
  }

  async pendingEvents(): Promise<readonly JourneyRuntimeEvent[]> {
    const events = await this.load(this.eventsPath());
    return Array.isArray(events) ? events.filter(isStoredEvent) : [];
  }

  async appendEvent(event: JourneyRuntimeEvent): Promise<void> {
    const events = await this.pendingEvents();
    await this.save(this.eventsPath(), [...events.filter((entry) => entry.event_id !== event.event_id), event]);
  }

  async removeEvent(eventId: string): Promise<void> {
    const events = await this.pendingEvents();
    await this.save(this.eventsPath(), events.filter((entry) => entry.event_id !== eventId));
  }
}

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


async function loadReceiptVerifier(): Promise<{
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

function requireVerifiedClaims(value: unknown): ReceiptClaims {
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
  if (!['status', 'next', 'verify', 'reset'].includes(action)) throw new Error(`unknown onboarding action: ${action}`);

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
  const transport = new VersionPinnedTransport(baseTransport);
  const storage = new FileJourneyStorage(stateDirectory(input, environment));
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
