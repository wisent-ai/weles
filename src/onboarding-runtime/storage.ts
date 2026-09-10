// Journey storage in memory and in the browser's localStorage.
import type { JourneyBundle, JourneyProgress } from './types'
import type { JourneyRuntimeEvent, JourneyStorage } from './contracts'

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
