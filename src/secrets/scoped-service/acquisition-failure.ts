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

export class SkarbiecAcquisitionError extends Error {
  readonly reason: AcquisitionReason | null;

  constructor(message: string, reason: AcquisitionReason | null) {
    // The bracketed reason is the machine-readable form a trajectory's stderr
    // carries to credential-outcome.mjs, which reads it instead of the words.
    super(reason ? `${message} [reason=${reason}]` : message);
    this.name = 'SkarbiecAcquisitionError';
    this.reason = reason;
  }
}

/** The helper's stderr split into its declared reason and the lines a person reads. */
export function acquisitionStderr(stderr: string): { reason: AcquisitionReason | null; lines: string[] } {
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
