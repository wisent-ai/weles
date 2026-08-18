// Vendored from wisent-ai/echo-web@82d46f43d65dd7435b9c0356ded164ede3e65da5 packages/onboarding-web/src.
export type JourneyScalar = string | number | boolean | null
export type JourneyEvidence = Readonly<Record<string, JourneyScalar | readonly JourneyScalar[]>>

export type JourneyCondition =
  | Readonly<{ kind: 'all'; conditions: readonly JourneyCondition[] }>
  | Readonly<{ kind: 'any'; conditions: readonly JourneyCondition[] }>
  | Readonly<{ kind: 'not'; condition: JourneyCondition }>
  | Readonly<{
      kind: 'fact'
      fact: string
      operator: 'present' | 'absent' | 'eq' | 'not_eq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte'
      value?: JourneyScalar
    }>

export interface JourneyTransition {
  readonly next_screen_id: string
  readonly reason_code: string
  readonly priority: number
  readonly condition?: JourneyCondition
}

export interface JourneyScreen {
  readonly screen_id: string
  readonly screen_kind: string
  readonly title_key: string
  readonly body_key: string
  readonly required: boolean
  readonly entry_conditions?: JourneyCondition
  readonly completion_evidence?: JourneyCondition
  readonly actions: readonly string[]
  readonly transitions: readonly JourneyTransition[]
  readonly fallback_screen_id?: string
  readonly presentation: Readonly<Record<string, JourneyScalar>>
}

export interface JourneyDefinition {
  readonly schema_version: 1
  readonly product_id: string
  readonly journey_id: string
  readonly journey_version: string
  readonly entry_screen_id: string
  readonly first_success_fact: string
  readonly published_at: string
  readonly source_revision: string
  readonly screens: readonly JourneyScreen[]
  readonly analytics_contract: Readonly<{
    contract_version: string
    surface: string
    exposure_event: string
    primary_action_event: string
    completion_event: string
    first_success_event: string
  }>
  readonly experiment_contract?: Readonly<{
    experiment_id: string
    control_variant_id: string
    eligible_variant_ids: readonly string[]
    variant_configs: Readonly<Record<string, Readonly<Record<string, string>>>>
    assignment_unit: 'user' | 'organization' | 'device'
    reward_event: string
    reward_window_hours: number
    guardrails: readonly Readonly<{
      event_name: string
      direction: 'min' | 'max'
      bound: number
      window_hours: number
    }>[]
    minimum_exposure_per_variant: number
    exploration_floor: number
    owner: string
    kill_switch: boolean
  }>
}

export interface JourneyBundle {
  readonly journey_version_id: string
  readonly definition: JourneyDefinition
  readonly canonical_definition: string
  readonly content_sha256: string
  readonly source_revision: string
}

export interface JourneyAnswer {
  readonly question_id: string
  readonly answer_id?: string
  readonly answer_value?: unknown
  readonly source_screen_id: string
}

export interface JourneyProgress {
  readonly attempt_id: string
  readonly product_id: string
  readonly journey_version_id: string
  readonly subject_hash: string
  readonly scope_kind: 'user' | 'organization' | 'device' | 'workload'
  readonly current_screen_id: string
  readonly completed_screen_ids: readonly string[]
  readonly status: 'in_progress' | 'skipped' | 'completed' | 'abandoned' | 'reset'
  readonly evidence_revision: string
  readonly experiment_id?: string
  readonly variant_id?: string
  readonly answers: readonly JourneyAnswer[]
  readonly first_action_completed?: boolean
  readonly first_success_observed?: boolean
}

export interface JourneyDecision {
  readonly selected_next_screen_id: string
  readonly reason_code: string
}

export interface JourneyAssignment {
  readonly variant: string
  readonly config: Readonly<Record<string, string>>
  readonly experimentId: string
}

export type JourneyEventName =
  | 'onboarding_started'
  | 'onboarding_step_viewed'
  | 'onboarding_step_completed'
  | 'onboarding_step_skipped'
  | 'onboarding_abandoned'
  | 'onboarding_resumed'
  | 'onboarding_reset'
  | 'onboarding_first_action_completed'
  | 'onboarding_first_success_observed'
  | 'onboarding_completed'
