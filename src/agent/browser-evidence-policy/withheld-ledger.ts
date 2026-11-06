// The declaration this policy publishes, and the ledger every withheld edge is
// written into. Only this file knows where a run's evidence directory is; the
// rest of the family reads the declaration and appends named edges here. Every
// edge is written whole: the run's retained evidence is bounded by the Spis
// bridge's total, which refuses the run by name rather than losing edges.
import { appendFileSync, constants, mkdirSync, writeFileSync } from 'node:fs';
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

/** Evidence files are readable and writable by the run's own user only. */
const OWNER_ONLY = constants.S_IRUSR | constants.S_IWUSR;

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

/** The run's evidence directory; a run without a label has nowhere its evidence belongs, and is refused. */
function evidenceDirectory(label: string): string {
  if (!label)
    throw new Error(
      'the browser-evidence ledger needs the run label that names its recordings directory',
    );
  const directory = runRecordingsDir(label);
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
    { encoding: 'utf8', mode: OWNER_ONLY },
  );
}

/**
 * One report from the page script's __welesRecordWithheldEdge binding: a
 * withheld call with its category and api, and, for a withholding the page
 * could not install, the reason it gave. A report without category and api is
 * kept as itself, not named for it.
 */
export function receiveWithheldEdge(label: string, raw: unknown): void {
  const edge =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  const category = edge ? safeText(edge.category) : '';
  const api = edge ? safeText(edge.api) : '';
  const reason = edge ? safeText(edge.reason) : '';
  if (!category || !api) {
    recordEdge(label, {
      category: 'withheld_edge_report_malformed',
      reason: `the page reported a withheld call without its category and api: ${JSON.stringify(raw)}`,
      source: 'page_api',
    });
    return;
  }
  recordEdge(
    label,
    reason
      ? { category, api, reason, source: 'page_api' }
      : { category, api, source: 'page_api' },
  );
}

export function writeBrowserEvidencePolicy(label: string): void {
  if (!enabled()) return;
  writeFileSync(
    join(evidenceDirectory(label), POLICY_FILE),
    `${JSON.stringify(SPIS_BROWSER_EVIDENCE_POLICY, null, '\t')}\n`,
    { encoding: 'utf8', mode: OWNER_ONLY },
  );
}
