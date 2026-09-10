// The transport a journey client speaks to the control plane through, the storage it keeps its progress in, and the event and assignment shapes they exchange.
import type { JourneyAssignment, JourneyBundle, JourneyEventName, JourneyProgress } from '../types'

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
