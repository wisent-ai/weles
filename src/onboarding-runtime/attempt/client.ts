// The journey client: loads the bundle, keeps progress, records evidence and collects events.
// Every step that left the control plane's current state (a cached or bundled
// definition, an unreconciled resume, an event the plane refused) is kept in
// `degraded` with its cause, and start() answers it beside the bundle.
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
import { IDENTIFIER, SHA256 } from '../journey/identifiers';
import {
  evaluateJourneyCondition,
  selectNextScreen,
} from '../journey/decision';
import { journeyEvent } from './progress';
import { loadJourneyBundle, type LoadedBundle } from './bundle-source';
import { openAttempt } from './opening';

export interface JourneyClientOptions {
  productId: string;
  journeyId: string;
  subjectHash: string;
  scopeKind: JourneyProgress['scope_kind'];
  transport: JourneyTransport;
  storage: JourneyStorage;
  canonicalFallback: JourneyBundle;
}

type Properties = Readonly<Record<string, unknown>>;

export class JourneyClient {
  readonly #options: JourneyClientOptions;
  #bundle: JourneyBundle | null = null;
  #progress: JourneyProgress | null = null;
  #degraded: string[] = [];
  #source: LoadedBundle['source'] | null = null;
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
  /** Where the journey definition came from: the control plane, this device's stored copy, or the product's bundled one. */
  get source(): LoadedBundle['source'] | null {
    return this.#source;
  }
  /** Why this attempt is not on the control plane's current state, one cause per step it fell back. */
  get degraded(): readonly string[] {
    return this.#degraded;
  }
  get screen() {
    const bundle = this.#bundle;
    const progress = this.#progress;
    if (!bundle || !progress) return null;
    const screen = bundle.definition.screens.find(
      (candidate) => candidate.screen_id === progress.current_screen_id,
    );
    if (!screen) return null;
    return screen;
  }

  start(evidenceRevision: string) {
    return this.#serialized(async () => {
      const {
        productId,
        journeyId,
        subjectHash,
        scopeKind,
        canonicalFallback,
        storage,
        transport,
      } = this.#options;
      const loaded = await loadJourneyBundle({
        productId,
        journeyId,
        transport,
        storage,
        canonicalFallback,
      });
      this.#bundle = loaded.bundle;
      this.#source = loaded.source;
      const opened = await openAttempt({
        productId,
        journeyId,
        subjectHash,
        scopeKind,
        transport,
        storage,
        bundle: loaded.bundle,
        evidenceRevision,
      });
      this.#degraded = [...loaded.degraded, ...opened.degraded];
      const eventName = opened.isResume
        ? 'onboarding_resumed'
        : 'onboarding_started';
      await this.#commit(opened.progress, [
        this.#event(opened.progress, eventName, {}, evidenceRevision),
      ]);
      return {
        bundle: loaded.bundle,
        source: loaded.source,
        progress: this.#progress,
        degraded: this.degraded,
      };
    });
  }

  async expose(evidenceRevision: string) {
    await this.emit('onboarding_step_viewed', {}, evidenceRevision);
  }

  advance(evidence: JourneyEvidence, evidenceRevision: string) {
    return this.#serialized(async () => {
      const { bundle, progress } = this.#started();
      const routingEvidence =
        progress.variant_id !== undefined &&
        !Object.prototype.hasOwnProperty.call(evidence, 'experiment_variant')
          ? { ...evidence, experiment_variant: progress.variant_id }
          : evidence;
      const decision = selectNextScreen(
        bundle.definition,
        progress.current_screen_id,
        routingEvidence,
      );
      if (!decision) return null;
      const completedScreenId = progress.current_screen_id;
      const next = {
        ...progress,
        current_screen_id: decision.selected_next_screen_id,
        completed_screen_ids: [
          ...new Set([...progress.completed_screen_ids, completedScreenId]),
        ],
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
    properties: Properties = {},
  ) {
    return this.#serialized(async () => {
      const { progress } = this.#started();
      const screen = this.screen;
      if (
        !screen ||
        !!screen.transitions.length ||
        (screen.completion_evidence &&
          !evaluateJourneyCondition(screen.completion_evidence, evidence))
      ) {
        return false;
      }
      const completedScreenId = progress.current_screen_id;
      const next: JourneyProgress = {
        ...progress,
        completed_screen_ids: [
          ...new Set([...progress.completed_screen_ids, completedScreenId]),
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

  observeFirstAction(evidenceRevision: string, properties: Properties = {}) {
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
    properties: Properties = {},
  ) {
    return this.#serialized(async () => {
      const { bundle, progress } = this.#started();
      if (evidence[bundle.definition.first_success_fact] !== true) return false;
      if (progress.first_success_observed) return false;
      const next = {
        ...progress,
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
      const { bundle, progress } = this.#started();
      const next: JourneyProgress = {
        ...progress,
        attempt_id: crypto.randomUUID(),
        current_screen_id: bundle.definition.entry_screen_id,
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
    properties: Properties,
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

  /** The started attempt's bundle and progress; a transition before start() is refused. */
  #started(): { bundle: JourneyBundle; progress: JourneyProgress } {
    if (!this.#bundle || !this.#progress)
      throw new Error('journey client has not started');
    return { bundle: this.#bundle, progress: this.#progress };
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

  // Freshly queued events; one the control plane refuses stays queued for
  // flush(), which reports it, and the refusal is kept in `degraded`.
  async #deliver(events: readonly JourneyRuntimeEvent[]) {
    for (const event of events) {
      // A refused collect, or a collected event that could not be dequeued, is recorded; flush() sends it again.
      const refusal = await this.#options.transport
        .collectEvent(event)
        .then(() => this.#options.storage.removeEvent(event.event_id))
        .then(
          () => null,
          (error: unknown) =>
            `event ${event.event_name} ${event.event_id} stays queued: ${error instanceof Error ? error.message : String(error)}`,
        );
      if (refusal !== null) {
        this.#degraded = [...this.#degraded, refusal];
        return;
      }
    }
  }
}
