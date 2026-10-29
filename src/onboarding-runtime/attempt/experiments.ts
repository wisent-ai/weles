// Which experiment variant a subject sees on a surface, or the control when none can be assigned.
import type { JourneyDefinition, JourneyProgress } from '../types';
import type {
  JourneyAssignmentInput,
  JourneyTransport,
} from '../plane/contracts';

type AssignmentPlatform = JourneyAssignmentInput['platform'];

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
};

function assignmentPlatform(surface: string): AssignmentPlatform | null {
  const named = surface.match(/^[a-z]+(?=[._:/-]|$)/);
  if (!named) return null;
  const [prefix] = named;
  return Object.prototype.hasOwnProperty.call(ASSIGNMENT_PLATFORMS, prefix)
    ? (prefix as AssignmentPlatform)
    : null;
}

type JourneyExperimentContract = NonNullable<
  JourneyDefinition['experiment_contract']
>;
export type JourneyExperimentIdentity = Pick<
  JourneyProgress,
  'experiment_id' | 'variant_id'
>;

export function controlAssignment(
  contract: JourneyExperimentContract,
): JourneyExperimentIdentity {
  return {
    experiment_id: contract.experiment_id,
    variant_id: contract.control_variant_id,
  };
}

export function isValidAssignment(
  contract: JourneyExperimentContract,
  experimentId: unknown,
  variantId: unknown,
) {
  return (
    experimentId === contract.experiment_id &&
    typeof variantId === 'string' &&
    contract.eligible_variant_ids.includes(variantId)
  );
}

/**
 * The arm a new attempt runs: the assigned variant, or the control the
 * immutable bundle declares. The control taken because the assignment failed
 * or answered an arm the contract does not hold carries the reason, so the
 * attempt records it and its control is not read as a randomized one.
 */
export async function resolveExperimentAssignment(
  contract: JourneyExperimentContract,
  transport: JourneyTransport,
  productId: string,
  subjectHash: string,
  surface: string,
): Promise<{ identity: JourneyExperimentIdentity; degraded: string | null }> {
  const control = controlAssignment(contract);
  const platform = assignmentPlatform(surface);
  if (contract.kill_switch) return { identity: control, degraded: null };
  if (platform === null) {
    return {
      identity: control,
      degraded: `surface ${surface} names no assignment platform, so experiment ${contract.experiment_id} runs its control`,
    };
  }
  return transport
    .assignExperiment({
      product_id: productId,
      app_id: productId,
      platform,
      surface,
      subject: subjectHash,
    })
    .then(
      (assignment) => {
        if (
          isValidAssignment(
            contract,
            assignment.experimentId,
            assignment.variant,
          )
        ) {
          return {
            identity: {
              experiment_id: assignment.experimentId,
              variant_id: assignment.variant,
            },
            degraded: null,
          };
        }
        return {
          identity: control,
          degraded: `experiment ${contract.experiment_id} was assigned ${JSON.stringify(assignment.experimentId)}/${JSON.stringify(assignment.variant)}, which its contract does not hold, so the attempt runs the control`,
        };
      },
      (error: unknown) => ({
        identity: control,
        degraded: `experiment ${contract.experiment_id} could not be assigned (${error instanceof Error ? error.message : String(error)}), so the attempt runs the control`,
      }),
    );
}
