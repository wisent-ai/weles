// A refused workload-bound Skarbiec acquisition, with the cause the helper
// (src/worker/deploy/acquire/skarbiec-acquire.mjs) declared on its
// `SKARBIEC_ACQUIRE_REASON <reason>` line. Callers branch on `reason`; the
// sentence is for the person reading the log.

export type AcquisitionReason =
  | 'refused'
  | 'scope_not_declared'
  | 'authority_unreachable'
  | 'workload_not_authorized'
  | 'field_not_present';

const REASONS: ReadonlySet<string> = new Set<AcquisitionReason>([
  'refused',
  'scope_not_declared',
  'authority_unreachable',
  'workload_not_authorized',
  'field_not_present',
]);

const REASON_LINE = 'SKARBIEC_ACQUIRE_REASON ';

export interface AcquisitionTarget {
  item: string;
  field: string;
  consumer: string;
}

/**
 * The one machine record of a refused acquisition, shared by the TypeScript
 * reader and src/_shared/scoped-secrets.mjs, and the only thing
 * credential-outcome.mjs reads from a trajectory's stderr about it:
 * `[skarbiec_acquisition item=<i> field=<f> consumer=<c>[ reason=<r>]]`.
 */
export function acquisitionRecord(
  target: AcquisitionTarget,
  reason: AcquisitionReason | null,
): string {
  const declared = reason ? ` reason=${reason}` : '';
  return `[skarbiec_acquisition item=${target.item} field=${target.field} consumer=${target.consumer}${declared}]`;
}

export class SkarbiecAcquisitionError extends Error {
  readonly code = 'skarbiec_acquisition_failed';
  readonly reason: AcquisitionReason | null;

  constructor(
    message: string,
    target: AcquisitionTarget,
    reason: AcquisitionReason | null,
  ) {
    super(`${message} ${acquisitionRecord(target, reason)}`);
    this.name = 'SkarbiecAcquisitionError';
    this.reason = reason;
  }
}

/** The helper's stderr split into its declared reason and the lines a person reads. */
export function acquisitionStderr(stderr: string): {
  reason: AcquisitionReason | null;
  lines: string[];
} {
  let reason: AcquisitionReason | null = null;
  const lines: string[] = [];
  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    if (!line || /^at\s/.test(line)) continue;
    if (line.startsWith(REASON_LINE)) {
      const named = line.slice(REASON_LINE.length);
      if (REASONS.has(named)) reason = named as AcquisitionReason;
      continue;
    }
    lines.push(line);
  }
  return { reason, lines };
}
