// The progress an attempt opens with: the stored attempt resumed (reconciled
// with what the control plane remembers) or a new one, with its experiment
// arm. A reconciliation that could not be read is recorded, not hidden: the
// attempt then runs on the progress kept on this device.
import type { JourneyBundle, JourneyProgress } from '../types';
import type { JourneyStorage, JourneyTransport } from '../plane/contracts';
import { UUID } from '../journey/identifiers';
import {
  controlAssignment,
  isValidAssignment,
  resolveExperimentAssignment,
} from './experiments';
import { reconcileRemoteProgress } from './progress';

export type OpenedAttempt = {
  progress: JourneyProgress;
  isResume: boolean;
  degraded: readonly string[];
};

export async function openAttempt(input: {
  productId: string;
  journeyId: string;
  subjectHash: string;
  scopeKind: JourneyProgress['scope_kind'];
  transport: JourneyTransport;
  storage: JourneyStorage;
  bundle: JourneyBundle;
  evidenceRevision: string;
}): Promise<OpenedAttempt> {
  const {
    productId,
    journeyId,
    subjectHash,
    scopeKind,
    transport,
    storage,
    bundle,
    evidenceRevision,
  } = input;
  const degraded: string[] = [];
  const stored = await storage.loadProgress(productId, journeyId, subjectHash);
  const isResume =
    !!stored &&
    stored.product_id === productId &&
    stored.subject_hash === subjectHash &&
    stored.scope_kind === scopeKind &&
    UUID.test(stored.attempt_id) &&
    stored.journey_version_id === bundle.journey_version_id &&
    stored.status !== 'reset';

  let progress: JourneyProgress;
  if (stored && isResume) {
    // A central-state outage or malformed answer does not block the offline journey; it is recorded.
    progress = await transport
      .readState(productId, stored.attempt_id, subjectHash)
      .then(
        (remote) => reconcileRemoteProgress(stored, bundle, remote),
        (error: unknown) => {
          degraded.push(
            `attempt ${stored.attempt_id} was not reconciled with the control plane: ${error instanceof Error ? error.message : String(error)}`,
          );
          return stored;
        },
      );
  } else {
    progress = {
      attempt_id: crypto.randomUUID(),
      product_id: productId,
      journey_version_id: bundle.journey_version_id,
      subject_hash: subjectHash,
      scope_kind: scopeKind,
      current_screen_id: bundle.definition.entry_screen_id,
      completed_screen_ids: [],
      status: 'in_progress',
      evidence_revision: evidenceRevision,
      answers: [],
    };
  }

  const experiment = bundle.definition.experiment_contract;
  if (experiment) {
    if (experiment.kill_switch) {
      progress = { ...progress, ...controlAssignment(experiment) };
    } else if (
      !isValidAssignment(
        experiment,
        progress.experiment_id,
        progress.variant_id,
      )
    ) {
      if (isResume) {
        degraded.push(
          `resumed attempt ${progress.attempt_id} holds no arm of experiment ${experiment.experiment_id}, so it runs the control`,
        );
        progress = { ...progress, ...controlAssignment(experiment) };
      } else {
        const assigned = await resolveExperimentAssignment(
          experiment,
          transport,
          productId,
          subjectHash,
          bundle.definition.analytics_contract.surface,
        );
        if (assigned.degraded) degraded.push(assigned.degraded);
        progress = { ...progress, ...assigned.identity };
      }
    }
  }
  return { progress, isResume, degraded };
}
