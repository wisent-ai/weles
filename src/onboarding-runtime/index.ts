// Vendored from wisent-ai/echo-web@82d46f43d65dd7435b9c0356ded164ede3e65da5 packages/onboarding-web/src.
export * from './types'

import type {
  JourneyAssignment,
  JourneyBundle,
  JourneyCondition,
  JourneyDecision,
  JourneyDefinition,
  JourneyEventName,
  JourneyEvidence,
  JourneyProgress,
  JourneyScalar,
  JourneyScreen,
  JourneyTransition,
} from './types'

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/
const SHA256 = /^[0-9a-f]{64}$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export interface JourneyTransport {
  readBundle(productId: string, journeyId: string, journeyVersion?: string): Promise<JourneyBundle>
  readState(productId: string, attemptId: string, subjectHash: string): Promise<unknown | null>
  collectEvent(event: JourneyRuntimeEvent): Promise<void>
  assignExperiment(input: JourneyAssignmentInput): Promise<JourneyAssignment>
}

export interface JourneyStorage {
  loadBundle(productId: string, journeyId: string): Promise<JourneyBundle | null>
  saveBundle(bundle: JourneyBundle): Promise<void>
  loadProgress(productId: string, journeyId: string, subjectHash: string): Promise<JourneyProgress | null>
  saveProgress(productId: string, journeyId: string, progress: JourneyProgress): Promise<void>
  pendingEvents(): Promise<readonly JourneyRuntimeEvent[]>
  appendEvent(event: JourneyRuntimeEvent): Promise<void>
  removeEvent(eventId: string): Promise<void>
}

export interface JourneyRuntimeEvent {
  readonly event_id: string
  readonly event_name: JourneyEventName
  readonly attempt_id: string
  readonly product_id: string
  readonly journey_version_id: string
  readonly subject_hash: string
  readonly scope_kind: JourneyProgress['scope_kind']
  readonly screen_id: string
  readonly occurred_at: string
  readonly evidence_revision: string
  readonly experiment_id?: string
  readonly variant_id?: string
  readonly selected_next_screen_id?: string
  readonly reason_code?: string
  readonly properties: Readonly<Record<string, unknown>>
  readonly answers: JourneyProgress['answers']
}

export interface JourneyAssignmentInput {
  readonly product_id: string
  readonly app_id: string
  readonly platform: 'web' | 'ios' | 'android' | 'macos' | 'desktop' | 'cli' | 'api' | 'worker' | 'operator' | 'python'
  readonly surface: string
  readonly subject: string
}

interface StadoEnvelope<T> {
  ok: boolean
  result?: T
  error?: { code?: string }
}

export class StadoJourneyTransport implements JourneyTransport {
  readonly #baseUrl: URL
  readonly #token: string
  readonly #fetch: typeof fetch

  constructor(input: { baseUrl: string; token: string; fetch?: typeof fetch }) {
    const baseUrl = new URL(input.baseUrl)
    if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/') {
      throw new Error('Stado baseUrl must be an HTTPS origin')
    }
    if (!input.token.trim()) throw new Error('Stado token is required')
    this.#baseUrl = baseUrl
    this.#token = input.token
    this.#fetch = input.fetch ?? globalThis.fetch
  }

  async #post<T>(productId: string, operation: string, body: unknown): Promise<T> {
    if (!IDENTIFIER.test(productId)) throw new Error('product_id is invalid')
    const endpoint = new URL(`api/integration/onboarding/${productId}.${operation}`, this.#baseUrl)
    const response = await this.#fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.#token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const envelope = await response.json() as StadoEnvelope<T>
    if (!response.ok || !envelope.ok || envelope.result === undefined) {
      throw new Error(`Onboarding transport failed: ${envelope.error?.code ?? response.status}`)
    }
    return envelope.result
  }

  readBundle(productId: string, journeyId: string, journeyVersion?: string) {
    return this.#post<JourneyBundle>(productId, 'bundle.read', {
      product_id: productId,
      journey_id: journeyId,
      journey_version: journeyVersion,
      if_none_match: null,
    })
  }

  async readState(productId: string, attemptId: string, subjectHash: string) {
    const result = await this.#post<{ found?: boolean; attempt?: unknown; answers?: unknown }>(productId, 'state.read', {
      product_id: productId,
      attempt_id: attemptId,
      subject_hash: subjectHash,
    })
    return result.found === false ? null : result
  }

  async collectEvent(event: JourneyRuntimeEvent) {
    await this.#post(event.product_id, 'events.collect', event)
  }

  assignExperiment(input: JourneyAssignmentInput) {
    return this.#post<JourneyAssignment>(input.product_id, 'experiments.assign', input)
  }
}

export class MemoryJourneyStorage implements JourneyStorage {
  readonly #bundles = new Map<string, JourneyBundle>()
  readonly #progress = new Map<string, JourneyProgress>()
  readonly #events = new Map<string, JourneyRuntimeEvent>()

  async loadBundle(productId: string, journeyId: string) {
    return this.#bundles.get(`${productId}\0${journeyId}`) ?? null
  }

  async saveBundle(bundle: JourneyBundle) {
    this.#bundles.set(`${bundle.definition.product_id}\0${bundle.definition.journey_id}`, bundle)
  }

  async loadProgress(productId: string, journeyId: string, subjectHash: string) {
    return this.#progress.get(`${productId}\0${journeyId}\0${subjectHash}`) ?? null
  }

  async saveProgress(productId: string, journeyId: string, progress: JourneyProgress) {
    this.#progress.set(`${productId}\0${journeyId}\0${progress.subject_hash}`, progress)
  }

  async pendingEvents() { return [...this.#events.values()] }
  async appendEvent(event: JourneyRuntimeEvent) { this.#events.set(event.event_id, event) }
  async removeEvent(eventId: string) { this.#events.delete(eventId) }
}

export class LocalStorageJourneyStorage implements JourneyStorage {
  readonly #namespace: string
  readonly #storage: Storage

  constructor(namespace: string, storage: Storage = globalThis.localStorage) {
    if (!namespace.trim()) throw new Error('journey storage namespace is required')
    this.#namespace = namespace
    this.#storage = storage
  }

  #key(kind: string, ...parts: string[]) {
    return [this.#namespace, kind, ...parts].join('.')
  }

  #read<T>(key: string): T | null {
    const value = this.#storage.getItem(key)
    if (value === null) return null
    try { return JSON.parse(value) as T } catch { return null }
  }

  async loadBundle(productId: string, journeyId: string) {
    return this.#read<JourneyBundle>(this.#key('bundle', productId, journeyId))
  }

  async saveBundle(bundle: JourneyBundle) {
    this.#storage.setItem(
      this.#key('bundle', bundle.definition.product_id, bundle.definition.journey_id),
      JSON.stringify(bundle),
    )
  }

  async loadProgress(productId: string, journeyId: string, subjectHash: string) {
    return this.#read<JourneyProgress>(this.#key('progress', productId, journeyId, subjectHash))
  }

  async saveProgress(productId: string, journeyId: string, progress: JourneyProgress) {
    this.#storage.setItem(
      this.#key('progress', productId, journeyId, progress.subject_hash),
      JSON.stringify(progress),
    )
  }

  async pendingEvents() {
    return this.#read<JourneyRuntimeEvent[]>(this.#key('events')) ?? []
  }

  async appendEvent(event: JourneyRuntimeEvent) {
    const events = await this.pendingEvents()
    const next = [...events.filter((entry) => entry.event_id !== event.event_id), event]
    this.#storage.setItem(this.#key('events'), JSON.stringify(next))
  }

  async removeEvent(eventId: string) {
    const events = await this.pendingEvents()
    this.#storage.setItem(
      this.#key('events'),
      JSON.stringify(events.filter((event) => event.event_id !== eventId)),
    )
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonical(entry)]))
  }
  return value
}

async function sha256Text(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

type AssignmentPlatform = JourneyAssignmentInput['platform']

const ASSIGNMENT_PLATFORMS: Readonly<Record<AssignmentPlatform, true>> = {
  web: true,
  ios: true,
  android: true,
  macos: true,
  desktop: true,
  cli: true,
  api: true,
  worker: true,
  operator: true,
  python: true,
}

function assignmentPlatform(surface: string): AssignmentPlatform | null {
  const prefix = surface.match(/^[a-z]+(?=[._:/-]|$)/)?.[0]
  return prefix && Object.prototype.hasOwnProperty.call(ASSIGNMENT_PLATFORMS, prefix)
    ? prefix as AssignmentPlatform
    : null
}

type JourneyExperimentContract = NonNullable<JourneyDefinition['experiment_contract']>
type JourneyExperimentIdentity = Pick<JourneyProgress, 'experiment_id' | 'variant_id'>

function controlAssignment(contract: JourneyExperimentContract): JourneyExperimentIdentity {
  return {
    experiment_id: contract.experiment_id,
    variant_id: contract.control_variant_id,
  }
}

function isValidAssignment(
  contract: JourneyExperimentContract,
  experimentId: unknown,
  variantId: unknown,
) {
  return experimentId === contract.experiment_id
    && typeof variantId === 'string'
    && contract.eligible_variant_ids.includes(variantId)
}

async function resolveExperimentAssignment(
  contract: JourneyExperimentContract,
  transport: JourneyTransport,
  productId: string,
  subjectHash: string,
  surface: string,
): Promise<JourneyExperimentIdentity> {
  const control = controlAssignment(contract)
  const platform = assignmentPlatform(surface)
  if (contract.kill_switch || platform === null) return control
  try {
    const assignment = await transport.assignExperiment({
      product_id: productId,
      app_id: productId,
      platform,
      surface,
      subject: subjectHash,
    })
    if (isValidAssignment(contract, assignment.experimentId, assignment.variant)) {
      return {
        experiment_id: assignment.experimentId,
        variant_id: assignment.variant,
      }
    }
  } catch {
    // Assignment is optional for first use; the immutable bundle declares the safe fallback.
  }
  return control
}

export async function validateJourneyBundle(bundle: JourneyBundle, productId: string, journeyId: string) {
  if (!bundle || typeof bundle !== 'object' || !UUID.test(bundle.journey_version_id)
    || !SHA256.test(bundle.content_sha256) || typeof bundle.canonical_definition !== 'string') {
    throw new Error('journey bundle envelope is invalid')
  }
  const definition = bundle.definition
  if (definition.schema_version !== 1 || definition.product_id !== productId || definition.journey_id !== journeyId) {
    throw new Error('journey bundle identity is invalid')
  }
  const experiment = definition.experiment_contract
  if (experiment !== undefined) {
    const variants = experiment.eligible_variant_ids
    if (!IDENTIFIER.test(experiment.experiment_id)
      || !IDENTIFIER.test(experiment.control_variant_id)
      || !Array.isArray(variants)
      || variants.length === 0
      || variants.some((variant) => typeof variant !== 'string' || !IDENTIFIER.test(variant))
      || new Set(variants).size !== variants.length
      || !variants.includes(experiment.control_variant_id)
      || typeof experiment.kill_switch !== 'boolean') {
      throw new Error('journey experiment contract is invalid')
    }
  }
  if (JSON.stringify(canonical(definition)) !== bundle.canonical_definition) {
    throw new Error('journey canonical definition does not match its decoded definition')
  }
  if (!Array.isArray(definition.screens) || definition.screens.length === 0 || definition.screens.length > 128) {
    throw new Error('journey screen graph is invalid')
  }
  const screens = new Map<string, JourneyScreen>()
  for (const screen of definition.screens) {
    if (!IDENTIFIER.test(screen.screen_id) || screens.has(screen.screen_id) || !Array.isArray(screen.transitions)) {
      throw new Error('journey screen is invalid')
    }
    screens.set(screen.screen_id, screen)
  }
  if (!screens.has(definition.entry_screen_id)) throw new Error('journey entry screen is missing')
  for (const screen of definition.screens) {
    if (screen.fallback_screen_id && !screens.has(screen.fallback_screen_id)) throw new Error('journey fallback is missing')
    if (screen.transitions.some((transition: JourneyTransition) => !screens.has(transition.next_screen_id))) throw new Error('journey transition target is missing')
  }
  if (await sha256Text(bundle.canonical_definition) !== bundle.content_sha256) {
    throw new Error('journey content hash does not match')
  }
  return bundle
}

function hasFact(evidence: JourneyEvidence, fact: string) {
  return Object.prototype.hasOwnProperty.call(evidence, fact) && evidence[fact] !== null
}

function numericPair(actual: JourneyScalar | readonly JourneyScalar[] | undefined, expected: JourneyScalar | undefined) {
  return typeof actual === 'number' && typeof expected === 'number' ? [actual, expected] as const : null
}

export function evaluateJourneyCondition(condition: JourneyCondition, evidence: JourneyEvidence): boolean {
  switch (condition.kind) {
    case 'all': return condition.conditions.every((entry) => evaluateJourneyCondition(entry, evidence))
    case 'any': return condition.conditions.some((entry) => evaluateJourneyCondition(entry, evidence))
    case 'not': return !evaluateJourneyCondition(condition.condition, evidence)
    case 'fact': {
      const actual = evidence[condition.fact]
      switch (condition.operator) {
        case 'present': return hasFact(evidence, condition.fact)
        case 'absent': return !hasFact(evidence, condition.fact)
        case 'eq': return actual === condition.value
        case 'not_eq': return actual !== condition.value
        case 'contains': return Array.isArray(actual) && actual.includes(condition.value as never)
        case 'gt': { const pair = numericPair(actual, condition.value); return pair !== null && pair[0] > pair[1] }
        case 'gte': { const pair = numericPair(actual, condition.value); return pair !== null && pair[0] >= pair[1] }
        case 'lt': { const pair = numericPair(actual, condition.value); return pair !== null && pair[0] < pair[1] }
        case 'lte': { const pair = numericPair(actual, condition.value); return pair !== null && pair[0] <= pair[1] }
      }
    }
  }
}

function canEnter(screen: JourneyScreen, evidence: JourneyEvidence) {
  return screen.entry_conditions === undefined || evaluateJourneyCondition(screen.entry_conditions, evidence)
}

export function selectNextScreen(definition: JourneyDefinition, currentScreenId: string, evidence: JourneyEvidence): JourneyDecision | null {
  const current = definition.screens.find((screen) => screen.screen_id === currentScreenId)
  if (!current) throw new Error(`unknown journey screen: ${currentScreenId}`)
  if (current.completion_evidence && !evaluateJourneyCondition(current.completion_evidence, evidence)) return null
  const selected = current.transitions.slice().sort((left, right) => left.priority - right.priority).find((transition) => {
    if (transition.condition && !evaluateJourneyCondition(transition.condition, evidence)) return false
    const target = definition.screens.find((screen) => screen.screen_id === transition.next_screen_id)
    return target !== undefined && canEnter(target, evidence)
  })
  if (selected) return { selected_next_screen_id: selected.next_screen_id, reason_code: selected.reason_code }
  if (current.fallback_screen_id) {
    const fallback = definition.screens.find((screen) => screen.screen_id === current.fallback_screen_id)
    if (fallback && canEnter(fallback, evidence)) {
      return { selected_next_screen_id: fallback.screen_id, reason_code: 'fallback_evidence_unavailable' }
    }
  }
  return null
}

export interface JourneyClientOptions {
  productId: string
  journeyId: string
  subjectHash: string
  scopeKind: JourneyProgress['scope_kind']
  transport: JourneyTransport
  storage: JourneyStorage
  canonicalFallback: JourneyBundle
}

function reconcileRemoteProgress(
  local: JourneyProgress,
  bundle: JourneyBundle,
  remote: unknown,
): JourneyProgress {
  if (remote === null || typeof remote !== 'object' || Array.isArray(remote)) return local
  const attempt = (remote as Record<string, unknown>).attempt
  if (attempt === null || typeof attempt !== 'object' || Array.isArray(attempt)) return local
  const value = attempt as Record<string, unknown>
  if (typeof value.id !== 'string'
    || !UUID.test(value.id)
    || value.id !== local.attempt_id
    || value.product_id !== local.product_id
    || typeof value.journey_version_id !== 'string'
    || !UUID.test(value.journey_version_id)
    || value.journey_version_id !== local.journey_version_id
    || value.journey_version_id !== bundle.journey_version_id
    || value.subject_hash !== local.subject_hash
    || value.scope_kind !== local.scope_kind
    || typeof value.current_screen_id !== 'string'
    || !Array.isArray(value.completed_screen_ids)
    || typeof value.status !== 'string'
    || !['in_progress', 'skipped', 'completed', 'abandoned'].includes(value.status)) {
    return local
  }
  const screenIds = new Set(bundle.definition.screens.map((screen) => screen.screen_id))
  const remoteCompleted = value.completed_screen_ids
  if (!screenIds.has(value.current_screen_id)
    || remoteCompleted.some((screenId) => typeof screenId !== 'string' || !screenIds.has(screenId))
    || new Set(remoteCompleted).size !== remoteCompleted.length) {
    return local
  }
  const completed = remoteCompleted as string[]
  if (!local.completed_screen_ids.every((screenId) => completed.includes(screenId))) return local
  const advanced = completed.length > local.completed_screen_ids.length
  if (value.current_screen_id !== local.current_screen_id
    && (!advanced || !completed.includes(local.current_screen_id))) {
    return local
  }
  const remoteCurrentIsCompleted = completed.includes(value.current_screen_id)
  if (local.status === 'completed'
    && (value.status !== 'completed' || value.current_screen_id !== local.current_screen_id)) {
    return local
  }
  if ((value.status === 'completed') !== remoteCurrentIsCompleted) return local
  return {
    ...local,
    current_screen_id: value.current_screen_id,
    completed_screen_ids: [
      ...local.completed_screen_ids,
      ...completed.filter((screenId) => !local.completed_screen_ids.includes(screenId)),
    ],
    status: value.status as JourneyProgress['status'],
  }
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
