// Which experiment variant a subject sees on a surface, or the control when none can be assigned.
import type { JourneyDefinition, JourneyProgress } from '../types'
import type { JourneyAssignmentInput, JourneyTransport } from '../plane/contracts'

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
export type JourneyExperimentIdentity = Pick<JourneyProgress, 'experiment_id' | 'variant_id'>

export function controlAssignment(contract: JourneyExperimentContract): JourneyExperimentIdentity {
  return {
    experiment_id: contract.experiment_id,
    variant_id: contract.control_variant_id,
  }
}

export function isValidAssignment(
  contract: JourneyExperimentContract,
  experimentId: unknown,
  variantId: unknown,
) {
  return experimentId === contract.experiment_id
    && typeof variantId === 'string'
    && contract.eligible_variant_ids.includes(variantId)
}

export async function resolveExperimentAssignment(
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
