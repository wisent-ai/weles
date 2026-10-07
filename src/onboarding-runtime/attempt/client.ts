// The journey client: loads the bundle, keeps progress, records evidence and collects events.
import type {
  JourneyBundle,
  JourneyDecision,
  JourneyEventName,
  JourneyEvidence,
  JourneyProgress,
} from '../types';
import type {
  JourneyRuntimeEvent,
  JourneyStorage,
  JourneyTransport,
} from '../plane/contracts';
import { IDENTIFIER, SHA256, UUID } from '../journey/identifiers';
import {
  controlAssignment,
  isValidAssignment,
  resolveExperimentAssignment,
} from './experiments';
import { validateJourneyBundle } from '../journey/bundle';
import {
  evaluateJourneyCondition,
  selectNextScreen,
} from '../journey/decision';
import { journeyEvent, reconcileRemoteProgress } from './progress';

export interface JourneyClientOptions {
  productId: string;
  journeyId: string;
  subjectHash: string;
  scopeKind: JourneyProgress['scope_kind'];
  transport: JourneyTransport;
  storage: JourneyStorage;
  canonicalFallback: JourneyBundle;
}

export class JourneyClient {
  readonly #options: JourneyClientOptions;
  #bundle: JourneyBundle | null = null;
  #progress: JourneyProgress | null = null;
  readonly #event = journeyEvent;
  // Transitions run one at a time, each from the progress the last one published.
  #turn: Promise<unknown> = Promise.resolve();

  constructor(options: JourneyClientOptions) {
    if (
      !IDENTIFIER.test(options.productId) ||
      !IDENTIFIER.test(options.journeyId) ||
      !SHA256.test(options.subjectHash)
    ) {
      throw new Error('journey client identity is invalid');
    }
    this.#options = options;
  }

  get bundle() {
    return this.#bundle;
  }
  get progress() {
    return this.#progress;
  }
  get screen() {
    if (!this.#bundle || !this.#progress) return null;
    return (
      this.#bundle.definition.screens.find(
        (screen) => screen.screen_id === this.#progress!.current_screen_id,
      ) ?? null
    );
  }

  start(evidenceRevision: string) {
    return this.#serialized(async () => {
      const {
        productId,
        journeyId,
        subjectHash,
        canonicalFallback,
        storage,
        transport,
      } = this.#options;
      let bundle: JourneyBundle | null = null;
      try {
        bundle = await validateJourneyBundle(
          await transport.readBundle(productId, journeyId),
          productId,
          journeyId,
        );
        await storage.saveBundle(bundle);
      } catch {
        const cached = await storage.loadBundle(productId, journeyId);
        if (cached) {
          try {
            bundle = await validateJourneyBundle(cached, productId, journeyId);
          } catch {
            bundle = null;
          }
        }
        if (!bundle)
          bundle = await validateJourneyBundle(
            canonicalFallback,
            productId,
            journeyId,
          );
      }
      this.#bundle = bundle;
      const stored = await storage.loadProgress(
        productId,
        journeyId,
        subjectHash,
      );
      const isResume =
        stored?.product_id === productId &&
        stored.subject_hash === subjectHash &&
        stored.scope_kind === this.#options.scopeKind &&
        UUID.test(stored.attempt_id) &&
        stored.journey_version_id === bundle.journey_version_id &&
        stored.status !== 'reset';
      let progress: JourneyProgress;
      if (isResume && stored) {
        progress = stored;
        try {
          const remote = await transport.readState(
            productId,
            stored.attempt_id,
            subjectHash,
          );
          progress = reconcileRemoteProgress(progress, bundle, remote);
        } catch {
          // A central-state outage or malformed response cannot block the bundled offline journey.
        }
      } else {
        progress = {
          attempt_id: crypto.randomUUID(),
          product_id: productId,
          journey_version_id: bundle.journey_version_id,
          subject_hash: subjectHash,
          scope_kind: this.#options.scopeKind,
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
          const assignment = isResume
            ? controlAssignment(experiment)
            : await resolveExperimentAssignment(
                experiment,
                transport,
                productId,
                subjectHash,
                bundle.definition.analytics_contract.surface,
              );
          progress = { ...progress, ...assignment };
        }
      }
      await this.#commit(progress, [
        this.#event(
          progress,
          isResume ? 'onboarding_resumed' : 'onboarding_started',
          {},
          evidenceRevision,
        ),
      ]);
      return { bundle, progress: this.#progress };
    });
  }

  async expose(evidenceRevision: string) {
    await this.emit('onboarding_step_viewed', {}, evidenceRevision);
  }

  advance(evidence: JourneyEvidence, evidenceRevision: string) {
    return this.#serialized(async () => {
      if (!this.#bundle || !this.#progress)
        throw new Error('journey client has not started');
      const routingEvidence =
        this.#progress.variant_id !== undefined &&
        !Object.prototype.hasOwnProperty.call(evidence, 'experiment_variant')
          ? { ...evidence, experiment_variant: this.#progress.variant_id }
          : evidence;
      const decision = selectNextScreen(
        this.#bundle.definition,
        this.#progress.current_screen_id,
        routingEvidence,
      );
      if (!decision) return null;
      const completedScreenId = this.#progress.current_screen_id;
      const completed = [
        ...new Set([...this.#progress.completed_screen_ids, completedScreenId]),
      ];
      const next = {
        ...this.#progress,
        current_screen_id: decision.selected_next_screen_id,
        completed_screen_ids: completed,
        evidence_revision: evidenceRevision,
      };
      await this.#commit(next, [
        this.#event(
          next,
          'onboarding_step_completed',
          {},
          evidenceRevision,
          decision,
          completedScreenId,
        ),
      ]);
      return decision;
    });
  }

  complete(
    evidence: JourneyEvidence,
    evidenceRevision: string,
    properties: Readonly<Record<string, unknown>> = {},
  ) {
    return this.#serialized(async () => {
      if (!this.#bundle || !this.#progress)
        throw new Error('journey client has not started');
      const screen = this.screen;
      if (
        !screen ||
        screen.transitions.length > 0 ||
        (screen.completion_evidence &&
          !evaluateJourneyCondition(screen.completion_evidence, evidence))
      ) {
        return false;
      }
      const completedScreenId = this.#progress.current_screen_id;
      const next: JourneyProgress = {
        ...this.#progress,
        completed_screen_ids: [
          ...new Set([
            ...this.#progress.completed_screen_ids,
            completedScreenId,
          ]),
        ],
        status: 'completed',
        evidence_revision: evidenceRevision,
      };
      await this.#commit(next, [
        this.#event(
          next,
          'onboarding_step_completed',
          properties,
          evidenceRevision,
          undefined,
          completedScreenId,
        ),
        this.#event(
          next,
          'onboarding_completed',
          properties,
          evidenceRevision,
          undefined,
          completedScreenId,
        ),
      ]);
      return true;
    });
  }

  observeFirstAction(
    evidenceRevision: string,
    properties: Readonly<Record<string, unknown>> = {},
  ) {
    return this.#serialized(async () => {
      if (!this.#progress) throw new Error('journey client has not started');
      if (this.#progress.first_action_completed) return false;
      const next = {
        ...this.#progress,
        first_action_completed: true,
        evidence_revision: evidenceRevision,
      };
      await this.#commit(next, [
        this.#event(
          next,
          'onboarding_first_action_completed',
          properties,
          evidenceRevision,
        ),
      ]);
      return true;
    });
  }

  observeFirstSuccess(
    evidence: JourneyEvidence,
    evidenceRevision: string,
    properties: Readonly<Record<string, unknown>> = {},
  ) {
    return this.#serialized(async () => {
      if (!this.#bundle || !this.#progress)
        throw new Error('journey client has not started');
      if (evidence[this.#bundle.definition.first_success_fact] !== true)
        return false;
      if (this.#progress.first_success_observed) return false;
      const next = {
        ...this.#progress,
        first_success_observed: true,
        evidence_revision: evidenceRevision,
      };
      await this.#commit(next, [
        this.#event(
          next,
          'onboarding_first_success_observed',
          properties,
          evidenceRevision,
        ),
      ]);
      return true;
    });
  }

  async skip(evidenceRevision: string) {
    await this.#moved('skipped', 'onboarding_step_skipped', evidenceRevision);
  }

  async abandon(evidenceRevision: string) {
    await this.#moved('abandoned', 'onboarding_abandoned', evidenceRevision);
  }

  async resume(evidenceRevision: string) {
    await this.#moved('in_progress', 'onboarding_resumed', evidenceRevision);
  }

  #moved(
    status: JourneyProgress['status'],
    eventName: JourneyEventName,
    evidenceRevision: string,
  ) {
    return this.#serialized(async () => {
      if (!this.#progress) throw new Error('journey client has not started');
      const next: JourneyProgress = {
        ...this.#progress,
        status,
        evidence_revision: evidenceRevision,
      };
      await this.#commit(next, [
        this.#event(next, eventName, {}, evidenceRevision),
      ]);
    });
  }

  reset(evidenceRevision: string) {
    return this.#serialized(async () => {
      if (!this.#bundle || !this.#progress)
        throw new Error('journey client has not started');
      const next: JourneyProgress = {
        ...this.#progress,
        attempt_id: crypto.randomUUID(),
        current_screen_id: this.#bundle.definition.entry_screen_id,
        completed_screen_ids: [],
        status: 'in_progress',
        evidence_revision: evidenceRevision,
        answers: [],
        first_action_completed: false,
        first_success_observed: false,
      };
      await this.#commit(next, [
        this.#event(next, 'onboarding_reset', {}, evidenceRevision),
        this.#event(next, 'onboarding_started', {}, evidenceRevision),
      ]);
    });
  }

  // An event that changes no progress (a screen being viewed): queued, then
  // offered to the control plane.
  async emit(
    eventName: JourneyEventName,
    properties: Readonly<Record<string, unknown>>,
    evidenceRevision: string,
    decision?: JourneyDecision,
    screenId?: string,
  ) {
    if (!this.#progress) throw new Error('journey client has not started');
    const event = this.#event(
      this.#progress,
      eventName,
      properties,
      evidenceRevision,
      decision,
      screenId,
    );
    await this.#options.storage.appendEvent(event);
    await this.#deliver([event]);
  }

  // Sends every queued event; the first refusal is thrown with it and every later event still queued.
  async flush() {
    for (const event of await this.#options.storage.pendingEvents()) {
      await this.#options.transport.collectEvent(event);
      await this.#options.storage.removeEvent(event.event_id);
    }
  }

  // Runs `step` after every transition queued before it, whether that one
  // succeeded or was refused; the caller still receives its own outcome.
  #serialized<T>(step: () => Promise<T>): Promise<T> {
    const run = this.#turn.then(step, step);
    this.#turn = Promise.allSettled([run]);
    return run;
  }

  // Stores a transition whole, then moves this client onto it; a refused write moves nothing.
  async #commit(next: JourneyProgress, events: readonly JourneyRuntimeEvent[]) {
    const { productId, journeyId, storage } = this.#options;
    await storage.commitProgress(productId, journeyId, next, events);
    this.#progress = next;
    await this.#deliver(events);
  }

  // Freshly queued events; one the control plane refuses stays queued for flush(), which reports it.
  async #deliver(events: readonly JourneyRuntimeEvent[]) {
    for (const event of events) {
      try {
        await this.#options.transport.collectEvent(event);
        await this.#options.storage.removeEvent(event.event_id);
      } catch {
        return;
      }
    }
  }
}
