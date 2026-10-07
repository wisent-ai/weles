// The declaration this policy publishes, and the ledger every withheld edge is
// written into. Only this file knows where a run's evidence directory is; the
// rest of the family reads the declaration and appends named edges here. Every
// edge is written whole: the run's retained evidence is bounded by the Spis
// bridge's total, which refuses the run by name rather than losing edges.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../session/run-recordings.js';

export const SPIS_BROWSER_EVIDENCE_POLICY = Object.freeze({
  schema: 'weles.browser-evidence-policy.v1',
  version: 'spis-browser-evidence.1',
  constraints: Object.freeze([
    'browser-permission-apis:withhold',
    'notification-apis:withhold',
    'permission-notification-controls:withhold',
    'system-ui-downloads:withhold',
    'authentication-signup-recovery:withhold',
    'mfa-trusted-device:withhold',
    'message-submission:withhold',
    'commerce-payment:withhold',
    'destructive-confirmation:withhold',
    'network:exact-public-origin-pinned',
    'interactive-controls:default-deny',
  ] as const),
});

const POLICY_FILE = 'browser_evidence_policy.json';
const WITHHELD_FILE = 'browser_evidence_withheld_edges.ndjson';

export function enabled(): boolean {
  return (
    process.env.WELES_BROWSER_EVIDENCE_POLICY ===
    SPIS_BROWSER_EVIDENCE_POLICY.version
  );
}

export function safeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// A failure this policy has to name in the ledger rather than pass over: the
// message of a dismissal, a cancellation, a refusal or a read that did not
// happen, rendered for one edge's `reason`.
export function describeEdgeFailure(error: unknown): string {
  return safeText(error instanceof Error ? error.message : String(error));
}

function evidenceDirectory(label: string): string {
  const directory = runRecordingsDir(label || 'generic_browser_task');
  mkdirSync(directory, { recursive: true });
  return directory;
}

export function recordEdge(label: string, edge: Record<string, unknown>): void {
  const document = {
    schema: 'weles.browser-evidence-withheld-edge.v1',
    policyVersion: SPIS_BROWSER_EVIDENCE_POLICY.version,
    recordedAt: new Date().toISOString(),
    ...edge,
  };
  appendFileSync(
    join(evidenceDirectory(label), WITHHELD_FILE),
    `${JSON.stringify(document)}\n`,
    {
      encoding: 'utf8',
      mode: 0o600,
    },
  );
}

export function writeBrowserEvidencePolicy(label: string): void {
  if (!enabled()) return;
  writeFileSync(
    join(evidenceDirectory(label), POLICY_FILE),
    `${JSON.stringify(SPIS_BROWSER_EVIDENCE_POLICY, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}
