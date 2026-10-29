// What a first-use run is asked and what it answers: the input, where the
// journey's state and subject come from, and the view a run renders.
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import type { JourneyProgress } from '../../onboarding-runtime';
import type { ReceiptClaims } from '../receipt.js';
import {
  CONTENT,
  JOURNEY_ID,
  JOURNEY_VERSION,
  PRODUCT_ID,
} from '../journey-surface.js';

export type OnboardingAction =
  | 'status'
  | 'next'
  | 'import'
  | 'verify'
  | 'reset';

/** Every action a first-use run answers. */
export const ONBOARDING_ACTIONS: Readonly<Record<OnboardingAction, true>> =
  Object.freeze({
    status: true,
    next: true,
    import: true,
    verify: true,
    reset: true,
  });

export type WelesOnboardingInput = {
  action?: OnboardingAction;
  subject?: string;
  stateDirectory?: string;
  receipt?: unknown;
  receiptKeys?: Readonly<Record<string, string>>;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  importReport?: Readonly<{
    imported: number;
    unchanged: number;
    refused: number;
  }>;
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
  // Where this run's journey definition came from: the control plane, the
  // copy stored on this device, or the one bundled with Weles; `degraded`
  // says why when it is not the control plane.
  journey_source: 'control_plane' | 'stored' | 'bundled';
  // Present when queued first-use events were refused by the control plane;
  // they stay queued and are sent again on the next run.
  undelivered_events?: string;
  // Present when this run left the control plane's current state: the journey
  // came from this device or the product, or the resume was not reconciled,
  // or an event stays queued; one cause per step.
  degraded?: string[];
  verified_receipt?: {
    task_id: string;
    outcome: string;
    evidence_digest: string;
    key_id: string;
  };
};

/**
 * Whose journey this is: the subject the caller states, else the one
 * WELES_ONBOARDING_SUBJECT states, else this machine's own user, whose
 * first use it is.
 */
export function stableSubject(
  input: WelesOnboardingInput,
  environment: NodeJS.ProcessEnv,
): string {
  const stated = input.subject?.trim();
  if (stated) return stated;
  const configured = environment.WELES_ONBOARDING_SUBJECT?.trim();
  if (configured) return configured;
  return `${userInfo().username}@${hostname()}`;
}

/**
 * Where the journey's state is kept: the directory the caller states, else
 * WELES_ONBOARDING_STATE_DIR, else Weles's own directory in the user's home.
 */
export function stateDirectory(
  input: WelesOnboardingInput,
  environment: NodeJS.ProcessEnv,
): string {
  if (input.stateDirectory) return input.stateDirectory;
  const configured = environment.WELES_ONBOARDING_STATE_DIR?.trim();
  if (configured) return configured;
  return join(homedir(), '.weles', 'onboarding');
}

export type ControlPlane = { connected: boolean; undeliveredEvents?: string };

export function render(
  client: {
    progress: JourneyProgress | null;
    screen: { screen_id: string; actions: readonly string[] } | null;
    degraded: readonly string[];
    source: 'control_plane' | 'stored' | 'bundled' | null;
  },
  plane: ControlPlane,
  claims?: ReceiptClaims,
): WelesOnboardingView {
  if (!client.progress || !client.screen || !client.source)
    throw new Error('Weles onboarding did not start');
  const content = CONTENT[client.screen.screen_id];
  if (!content)
    throw new Error(
      `Weles has no product content for journey screen ${client.screen.screen_id}`,
    );
  const view: WelesOnboardingView = {
    product_id: PRODUCT_ID,
    journey_id: JOURNEY_ID,
    journey_version: JOURNEY_VERSION,
    status: client.progress.status,
    attempt_id: client.progress.attempt_id,
    screen: {
      id: client.screen.screen_id,
      title: content.title,
      body: content.body,
      // A completed journey offers no further action.
      actions:
        client.progress.status === 'completed' ? [] : client.screen.actions,
    },
    control_plane: plane.connected ? 'connected' : 'offline',
    journey_source: client.source,
  };
  if (plane.undeliveredEvents)
    view.undelivered_events = plane.undeliveredEvents;
  if (client.degraded.length) view.degraded = [...client.degraded];
  if (claims)
    view.verified_receipt = {
      task_id: claims.taskId,
      outcome: claims.outcome,
      evidence_digest: claims.evidenceDigest,
      key_id: claims.keyId,
    };
  return view;
}
