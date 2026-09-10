// Reconcile the progress the control plane remembers with the progress kept locally.
import type { JourneyBundle, JourneyProgress } from '../types'
import { UUID } from '../journey/identifiers'

export function reconcileRemoteProgress(
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
