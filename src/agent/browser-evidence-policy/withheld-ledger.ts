// The declaration this policy publishes, and the ledger every withheld edge is
// written into. Only this file knows where a run's evidence directory is, what a
// single ledger entry may cost, and how much of a ledger one run may hold; the
// rest of the family reads the declaration and appends named edges here.
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
const MAX_EDGE_TEXT = 240;
const MAX_WITHHELD_BYTES = 2 * 1024 * 1024;
const MAX_WITHHELD_EDGES = 2_048;
const MAX_EDGE_LINE_BYTES = 4_096;
const edgeStates = new Map<string, { bytes: number; count: number; truncated: boolean }>();

export function enabled(): boolean {
  return process.env.WELES_BROWSER_EVIDENCE_POLICY === SPIS_BROWSER_EVIDENCE_POLICY.version;
}

export function safeText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_EDGE_TEXT);
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
  const path = join(evidenceDirectory(label), WITHHELD_FILE);
  const state = edgeStates.get(path) ?? { bytes: 0, count: 0, truncated: false };
  const document = {
    schema: 'weles.browser-evidence-withheld-edge.v1',
    policyVersion: SPIS_BROWSER_EVIDENCE_POLICY.version,
    recordedAt: new Date().toISOString(),
    ...edge,
  };
  let line = `${JSON.stringify(document)}\n`;
  if (Buffer.byteLength(line) > MAX_EDGE_LINE_BYTES) {
    line = `${JSON.stringify({
      schema: 'weles.browser-evidence-withheld-edge.v1',
      policyVersion: SPIS_BROWSER_EVIDENCE_POLICY.version,
      recordedAt: document.recordedAt,
      category: safeText(edge.category) || 'withheld_edge',
      reason: 'withheld edge detail exceeded the per-entry bound',
      source: safeText(edge.source) || 'policy',
    })}\n`;
  }
  const lineBytes = Buffer.byteLength(line);
  if (state.count >= MAX_WITHHELD_EDGES || state.bytes + lineBytes > MAX_WITHHELD_BYTES - 512) {
    if (!state.truncated) {
      const marker = `${JSON.stringify({
        schema: 'weles.browser-evidence-withheld-edge.v1',
        policyVersion: SPIS_BROWSER_EVIDENCE_POLICY.version,
        recordedAt: new Date().toISOString(),
        category: 'retention_limit',
        reason: 'additional withheld edges omitted after the execution-time retention bound',
        source: 'policy',
      })}\n`;
      appendFileSync(path, marker, { encoding: 'utf8', mode: 0o600 });
      state.bytes += Buffer.byteLength(marker);
      state.truncated = true;
    }
    edgeStates.set(path, state);
    return;
  }
  appendFileSync(path, line, { encoding: 'utf8', mode: 0o600 });
  state.bytes += lineBytes;
  state.count += 1;
  edgeStates.set(path, state);
}

export function writeBrowserEvidencePolicy(label: string): void {
  if (!enabled()) return;
  writeFileSync(
    join(evidenceDirectory(label), POLICY_FILE),
    `${JSON.stringify(SPIS_BROWSER_EVIDENCE_POLICY, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}
