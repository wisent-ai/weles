// Whether a bundle is what it claims to be: identity, experiment contract, screen graph and content digest.
import type { JourneyBundle, JourneyScreen, JourneyTransition } from '../types'
import { IDENTIFIER, SHA256, UUID } from './identifiers'
import { canonical, sha256Text } from './canonical'

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
