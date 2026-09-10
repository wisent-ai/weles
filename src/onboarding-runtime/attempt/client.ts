// The journey client: loads the bundle, keeps progress, records evidence and collects events.
import type { JourneyBundle, JourneyDecision, JourneyEventName, JourneyEvidence, JourneyProgress } from '../types'
import type { JourneyRuntimeEvent, JourneyStorage, JourneyTransport } from '../plane/contracts'
import { IDENTIFIER, SHA256, UUID } from '../journey/identifiers'
import { controlAssignment, isValidAssignment, resolveExperimentAssignment } from './experiments'
import { validateJourneyBundle } from '../journey/bundle'
import { evaluateJourneyCondition, selectNextScreen } from '../journey/decision'
import { reconcileRemoteProgress } from './progress'

export interface JourneyClientOptions {
  productId: string
  journeyId: string
  subjectHash: string
  scopeKind: JourneyProgress['scope_kind']
  transport: JourneyTransport
  storage: JourneyStorage
  canonicalFallback: JourneyBundle
}

export class JourneyClient {
  readonly #options: JourneyClientOptions
  #bundle: JourneyBundle | null = null
  #progress: JourneyProgress | null = null

  constructor(options: JourneyClientOptions) {
    if (!IDENTIFIER.test(options.productId) || !IDENTIFIER.test(options.journeyId) || !SHA256.test(options.subjectHash)) {
      throw new Error('journey client identity is invalid')
    }
    this.#options = options
  }

  get bundle() { return this.#bundle }
  get progress() { return this.#progress }
  get screen() {
    if (!this.#bundle || !this.#progress) return null
    return this.#bundle.definition.screens.find((screen) => screen.screen_id === this.#progress!.current_screen_id) ?? null
  }

  async start(evidenceRevision: string) {
    const { productId, journeyId, subjectHash, canonicalFallback, storage, transport } = this.#options
    let bundle: JourneyBundle | null = null
    try {
      bundle = await validateJourneyBundle(await transport.readBundle(productId, journeyId), productId, journeyId)
      await storage.saveBundle(bundle)
    } catch {
      const cached = await storage.loadBundle(productId, journeyId)
      if (cached) {
        try { bundle = await validateJourneyBundle(cached, productId, journeyId) } catch { bundle = null }
      }
      if (!bundle) bundle = await validateJourneyBundle(canonicalFallback, productId, journeyId)
    }
    this.#bundle = bundle
    const stored = await storage.loadProgress(productId, journeyId, subjectHash)
    const isResume = stored?.product_id === productId
      && stored.subject_hash === subjectHash
      && stored.scope_kind === this.#options.scopeKind
      && UUID.test(stored.attempt_id)
      && stored.journey_version_id === bundle.journey_version_id
      && stored.status !== 'reset'
    let progress: JourneyProgress
    if (isResume && stored) {
      progress = stored
      try {
        const remote = await transport.readState(productId, stored.attempt_id, subjectHash)
        progress = reconcileRemoteProgress(progress, bundle, remote)
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
      }
    }
    const experiment = bundle.definition.experiment_contract
    if (experiment) {
      if (experiment.kill_switch) {
        progress = { ...progress, ...controlAssignment(experiment) }
      } else if (!isValidAssignment(experiment, progress.experiment_id, progress.variant_id)) {
        const assignment = isResume
          ? controlAssignment(experiment)
          : await resolveExperimentAssignment(
              experiment,
              transport,
              productId,
              subjectHash,
              bundle.definition.analytics_contract.surface,
            )
        progress = { ...progress, ...assignment }
      }
    }
    this.#progress = progress
    await storage.saveProgress(productId, journeyId, progress)
    await this.emit(isResume ? 'onboarding_resumed' : 'onboarding_started', {}, evidenceRevision)
    return { bundle, progress: this.#progress }
  }

  async expose(evidenceRevision: string) {
    await this.emit('onboarding_step_viewed', {}, evidenceRevision)
  }

  async advance(evidence: JourneyEvidence, evidenceRevision: string) {
    if (!this.#bundle || !this.#progress) throw new Error('journey client has not started')
    const routingEvidence = this.#progress.variant_id !== undefined
      && !Object.prototype.hasOwnProperty.call(evidence, 'experiment_variant')
      ? { ...evidence, experiment_variant: this.#progress.variant_id }
      : evidence
    const decision = selectNextScreen(this.#bundle.definition, this.#progress.current_screen_id, routingEvidence)
    if (!decision) return null
    const completedScreenId = this.#progress.current_screen_id
    const completed = [...new Set([...this.#progress.completed_screen_ids, completedScreenId])]
    this.#progress = {
      ...this.#progress,
      current_screen_id: decision.selected_next_screen_id,
      completed_screen_ids: completed,
      evidence_revision: evidenceRevision,
    }
    await this.#options.storage.saveProgress(this.#options.productId, this.#options.journeyId, this.#progress)
    await this.emit('onboarding_step_completed', {}, evidenceRevision, decision, completedScreenId)
    return decision
  }

  async complete(
    evidence: JourneyEvidence,
    evidenceRevision: string,
    properties: Readonly<Record<string, unknown>> = {},
  ) {
    if (!this.#bundle || !this.#progress) throw new Error('journey client has not started')
    const screen = this.screen
    if (!screen || screen.transitions.length > 0
      || (screen.completion_evidence && !evaluateJourneyCondition(screen.completion_evidence, evidence))) {
      return false
    }
    const completedScreenId = this.#progress.current_screen_id
    this.#progress = {
      ...this.#progress,
      completed_screen_ids: [...new Set([...this.#progress.completed_screen_ids, completedScreenId])],
      status: 'completed',
      evidence_revision: evidenceRevision,
    }
    await this.#options.storage.saveProgress(this.#options.productId, this.#options.journeyId, this.#progress)
    await this.emit('onboarding_step_completed', properties, evidenceRevision, undefined, completedScreenId)
    await this.emit('onboarding_completed', properties, evidenceRevision, undefined, completedScreenId)
    return true
  }

  async observeFirstAction(
    evidenceRevision: string,
    properties: Readonly<Record<string, unknown>> = {},
  ) {
    if (!this.#progress) throw new Error('journey client has not started')
    if (this.#progress.first_action_completed) return false
    this.#progress = {
      ...this.#progress,
      first_action_completed: true,
      evidence_revision: evidenceRevision,
    }
    await this.#options.storage.saveProgress(this.#options.productId, this.#options.journeyId, this.#progress)
    await this.emit('onboarding_first_action_completed', properties, evidenceRevision)
    return true
  }

  async observeFirstSuccess(
    evidence: JourneyEvidence,
    evidenceRevision: string,
    properties: Readonly<Record<string, unknown>> = {},
  ) {
    if (!this.#bundle || !this.#progress) throw new Error('journey client has not started')
    if (evidence[this.#bundle.definition.first_success_fact] !== true) return false
    if (this.#progress.first_success_observed) return false
    this.#progress = {
      ...this.#progress,
      first_success_observed: true,
      evidence_revision: evidenceRevision,
    }
    await this.#options.storage.saveProgress(this.#options.productId, this.#options.journeyId, this.#progress)
    await this.emit('onboarding_first_success_observed', properties, evidenceRevision)
    return true
  }

  async skip(evidenceRevision: string) {
    if (!this.#progress) throw new Error('journey client has not started')
    this.#progress = { ...this.#progress, status: 'skipped', evidence_revision: evidenceRevision }
    await this.#options.storage.saveProgress(this.#options.productId, this.#options.journeyId, this.#progress)
    await this.emit('onboarding_step_skipped', {}, evidenceRevision)
  }

  async abandon(evidenceRevision: string) {
    if (!this.#progress) throw new Error('journey client has not started')
    this.#progress = { ...this.#progress, status: 'abandoned', evidence_revision: evidenceRevision }
    await this.#options.storage.saveProgress(this.#options.productId, this.#options.journeyId, this.#progress)
    await this.emit('onboarding_abandoned', {}, evidenceRevision)
  }

  async resume(evidenceRevision: string) {
    if (!this.#progress) throw new Error('journey client has not started')
    this.#progress = { ...this.#progress, status: 'in_progress', evidence_revision: evidenceRevision }
    await this.#options.storage.saveProgress(this.#options.productId, this.#options.journeyId, this.#progress)
    await this.emit('onboarding_resumed', {}, evidenceRevision)
  }

  async reset(evidenceRevision: string) {
    if (!this.#bundle || !this.#progress) throw new Error('journey client has not started')
    this.#progress = {
      ...this.#progress,
      attempt_id: crypto.randomUUID(),
      current_screen_id: this.#bundle.definition.entry_screen_id,
      completed_screen_ids: [],
      status: 'in_progress',
      evidence_revision: evidenceRevision,
      answers: [],
      first_action_completed: false,
      first_success_observed: false,
    }
    await this.#options.storage.saveProgress(this.#options.productId, this.#options.journeyId, this.#progress)
    await this.emit('onboarding_reset', {}, evidenceRevision)
    await this.emit('onboarding_started', {}, evidenceRevision)
  }

  async emit(
    eventName: JourneyEventName,
    properties: Readonly<Record<string, unknown>>,
    evidenceRevision: string,
    decision?: JourneyDecision,
    screenId?: string,
  ) {
    if (!this.#progress) throw new Error('journey client has not started')
    const event: JourneyRuntimeEvent = {
      event_id: crypto.randomUUID(),
      event_name: eventName,
      attempt_id: this.#progress.attempt_id,
      product_id: this.#progress.product_id,
      journey_version_id: this.#progress.journey_version_id,
      subject_hash: this.#progress.subject_hash,
      scope_kind: this.#progress.scope_kind,
      screen_id: screenId ?? this.#progress.current_screen_id,
      occurred_at: new Date().toISOString(),
      evidence_revision: evidenceRevision,
      experiment_id: this.#progress.experiment_id,
      variant_id: this.#progress.variant_id,
      selected_next_screen_id: decision?.selected_next_screen_id,
      reason_code: decision?.reason_code,
      properties,
      answers: this.#progress.answers,
    }
    await this.#options.storage.appendEvent(event)
    try {
      await this.#options.transport.collectEvent(event)
      await this.#options.storage.removeEvent(event.event_id)
    } catch {
      // Local progress and the idempotent event remain queued; first use must not depend on the control plane.
    }
  }

  async flush() {
    for (const event of await this.#options.storage.pendingEvents()) {
      try {
        await this.#options.transport.collectEvent(event)
        await this.#options.storage.removeEvent(event.event_id)
      } catch {
        return
      }
    }
  }
}
