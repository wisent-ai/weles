// The Stado control plane as a journey transport: one POST per operation, one envelope per answer.
import type { JourneyAssignment, JourneyBundle } from '../types'
import type { JourneyAssignmentInput, JourneyRuntimeEvent, JourneyTransport } from './contracts'
import { IDENTIFIER } from '../journey/identifiers'

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
