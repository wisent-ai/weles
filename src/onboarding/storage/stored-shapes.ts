// The shapes the first-use journey's stored files must have before they are
// believed: a bundle, a progress record and a pending event, each read by its
// own properties (never through a getter a parsed document could carry).
import type {
  JourneyBundle,
  JourneyProgress,
  JourneyRuntimeEvent,
} from '../../onboarding-runtime';

/** `value`'s own `field`, read without running a getter it could carry. */
export function storedProperty(value: unknown, field: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}

export function isStoredBundle(value: unknown): value is JourneyBundle {
  const storedDefinition = storedProperty(value, 'definition');
  const screens = storedProperty(storedDefinition, 'screens');
  return (
    typeof storedProperty(value, 'journey_version_id') === 'string' &&
    typeof storedProperty(value, 'canonical_definition') === 'string' &&
    typeof storedProperty(value, 'content_sha256') === 'string' &&
    typeof storedProperty(value, 'source_revision') === 'string' &&
    storedProperty(storedDefinition, 'schema_version') === 1 &&
    typeof storedProperty(storedDefinition, 'product_id') === 'string' &&
    typeof storedProperty(storedDefinition, 'journey_id') === 'string' &&
    Array.isArray(screens) &&
    screens.every(
      (screen) =>
        typeof storedProperty(screen, 'screen_id') === 'string' &&
        Array.isArray(storedProperty(screen, 'actions')) &&
        Array.isArray(storedProperty(screen, 'transitions')),
    )
  );
}

export function isStoredProgress(value: unknown): value is JourneyProgress {
  const scopeKind = storedProperty(value, 'scope_kind');
  const status = storedProperty(value, 'status');
  const completedScreenIds = storedProperty(value, 'completed_screen_ids');
  const answers = storedProperty(value, 'answers');
  return (
    typeof storedProperty(value, 'attempt_id') === 'string' &&
    typeof storedProperty(value, 'product_id') === 'string' &&
    typeof storedProperty(value, 'journey_version_id') === 'string' &&
    typeof storedProperty(value, 'subject_hash') === 'string' &&
    (scopeKind === 'user' ||
      scopeKind === 'organization' ||
      scopeKind === 'device' ||
      scopeKind === 'workload') &&
    typeof storedProperty(value, 'current_screen_id') === 'string' &&
    Array.isArray(completedScreenIds) &&
    completedScreenIds.every((screenId) => typeof screenId === 'string') &&
    (status === 'in_progress' ||
      status === 'skipped' ||
      status === 'completed' ||
      status === 'abandoned' ||
      status === 'reset') &&
    typeof storedProperty(value, 'evidence_revision') === 'string' &&
    Array.isArray(answers)
  );
}

export function isStoredEvent(value: unknown): value is JourneyRuntimeEvent {
  const properties = storedProperty(value, 'properties');
  return (
    typeof storedProperty(value, 'event_id') === 'string' &&
    typeof storedProperty(value, 'event_name') === 'string' &&
    typeof storedProperty(value, 'attempt_id') === 'string' &&
    typeof storedProperty(value, 'product_id') === 'string' &&
    typeof storedProperty(value, 'journey_version_id') === 'string' &&
    typeof storedProperty(value, 'subject_hash') === 'string' &&
    typeof storedProperty(value, 'screen_id') === 'string' &&
    typeof storedProperty(value, 'occurred_at') === 'string' &&
    typeof storedProperty(value, 'evidence_revision') === 'string' &&
    properties !== null &&
    typeof properties === 'object' &&
    !Array.isArray(properties) &&
    Array.isArray(storedProperty(value, 'answers'))
  );
}
