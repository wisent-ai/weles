// Conditions over the evidence a journey has gathered, and the next screen they select.
import type { JourneyCondition, JourneyDecision, JourneyDefinition, JourneyEvidence, JourneyScalar, JourneyScreen } from './types'

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
