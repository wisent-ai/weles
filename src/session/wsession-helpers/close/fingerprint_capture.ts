// The fingerprint a closing session records for itself: the probe script
// run in the page, the network-side fingerprint, and the analysis against
// the baseline of the persona's own browser family. Split out of finalize.ts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FP_SCRIPT } from '../../../diagnostics/fingerprint_probe.js';
import {
  NETWORK_FP_URL,
  parseNetworkFingerprint,
} from '../../../diagnostics/network/fingerprint.js';
import {
  analyze,
  pickBaseline,
  summarize,
  type FingerprintReport,
} from '../../../diagnostics/fingerprint_analyzer.js';
import type { WSession } from '../../wsession.js';
import { runRecordingsDir, runRecordingsRoot } from '../../run-recordings.js';

/** Recording files are written indented by one tab, readable by a person. */
const JSON_INDENT = '\t';

/** The network fingerprint fields compared between the early and the close-time capture. */
type DriftField = 'ja4' | 'peetprint_hash' | 'akamaiH2';
const DRIFT_FIELDS: Record<DriftField, true> = { ja4: true, peetprint_hash: true, akamaiH2: true };

/**
 * The TLS extension a resumed session adds after the target site was visited
 * (RFC 8446, section 4.2.11: https://www.rfc-editor.org/rfc/rfc8446#section-4.2.11),
 * as the network probe names it.
 */
const PSK_EXTENSION = 'pre_shared_key (41)';

/** The findings a PSK-only drift explains: the early and close-time TLS fingerprints differ by resumption alone. */
const PSK_EXPLAINED_FINDINGS: Record<string, true> = { tls_ja4_mismatch: true, tls_peetprint_mismatch: true };

export function recordingsDir(label?: string): string {
  return label ? runRecordingsDir(label) : runRecordingsRoot();
}

function extensionsOf(network: any): Set<string> {
  const listed = network?.extensions;
  if (!Array.isArray(listed)) return new Set();
  return new Set(listed.filter((extension: unknown): extension is string => typeof extension === 'string' && !extension.startsWith('TLS_GREASE')));
}

function fieldOf(network: any, field: DriftField): string | null {
  const value = network?.[field];
  if (typeof value === 'string' && value) return value;
  return null;
}

/**
 * Compares the early capture with the close-time one: the fields that changed
 * are written to network_drift.json, and the drift is explained by PSK
 * resumption when the only extension added is pre_shared_key and none was
 * removed.
 */
function compareDrift(label: string, network: any): boolean {
  const earlyPath = join(recordingsDir(label), 'early_fingerprint.json');
  if (!existsSync(earlyPath)) return false;
  const early = JSON.parse(readFileSync(earlyPath, 'utf-8'));
  const earlyExtensions = extensionsOf(early?.network);
  const finalExtensions = extensionsOf(network);
  const added = [...finalExtensions].filter((extension) => !earlyExtensions.has(extension));
  const removed = [...earlyExtensions].filter((extension) => !finalExtensions.has(extension));
  const pskDrift = added.join(',') === PSK_EXTENSION && !removed.length;
  const drift: Record<string, { early: string; final: string; pskExpected: boolean }> = {};
  for (const field of Object.keys(DRIFT_FIELDS) as DriftField[]) {
    const before = fieldOf(early?.network, field);
    const after = fieldOf(network, field);
    if (before && after && before !== after) drift[field] = { early: before, final: after, pskExpected: pskDrift };
  }
  const changed = Object.keys(drift);
  if (changed.length) {
    const driftPath = join(recordingsDir(label), 'network_drift.json');
    writeFileSync(driftPath, JSON.stringify({ capturedAt: new Date().toISOString(), pskDrift, drift }, null, JSON_INDENT));
    console.log(`[wsession] network drift detected: ${changed.join(', ')}${pskDrift ? ' (expected PSK resumption)' : ''} — saved ${driftPath}`);
  }
  return pskDrift;
}

/** The report without the TLS mismatches a PSK-only drift explains, counted again by the analyzer's own summary. */
function withoutPskFindings(report: FingerprintReport): FingerprintReport {
  const findings = report.findings.filter((finding) => !Object.hasOwn(PSK_EXPLAINED_FINDINGS, finding.id));
  return { ...report, meta: { ...report.meta, pskDriftExplained: true }, findings, summary: summarize(findings) };
}

export async function wsCaptureFingerprint(s: WSession): Promise<void> {
  if (!s.label) return;
  if (process.env.WELES_FINGERPRINT === '0') return;
  try {
    // The probe announces each section that waits on the browser; printing
    // it here names the one a probe that never answers stands in. A page
    // that already carries the binding (a second capture) keeps the first.
    await s.page
      .exposeFunction('__welesFingerprintSection', (section: string) => {
        console.log(`[wsession] fingerprint probe: ${section}`);
      })
      .catch((error: Error) =>
        console.log(`[wsession] fingerprint probe sections unannounced: ${error.message}`),
      );
    const js = await s.page.evaluate(FP_SCRIPT);
    let network: any;
    try {
      console.log(`[wsession] fingerprint probe: network ${NETWORK_FP_URL}`);
      await s.page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded' });
      const raw = await s.page.evaluate(`document.body.innerText || document.body.textContent || ''`);
      network = parseNetworkFingerprint(raw);
    } catch (e: any) {
      network = { _err: String(e?.message ?? e) };
    }
    // A session that recorded no browser provenance is written as null: the
    // fingerprint does not say which browser produced it.
    const provenance = (s as any)._browserProvenance;
    const payload = {
      capturedAt: new Date().toISOString(),
      source: 'weles-auto',
      browser: provenance ? provenance.browser : null,
      js,
      network,
    };
    const fpPath = join(recordingsDir(s.label), 'fingerprint.json');
    writeFileSync(fpPath, JSON.stringify(payload, null, JSON_INDENT));
    console.log(`[wsession] fingerprint saved ${fpPath}`);

    const baselineDir = process.env.WELES_BASELINE_DIR || join(process.cwd(), 'recordings', 'baselines');
    if (!existsSync(baselineDir)) {
      console.log(`[wsession] detection report not written: no baseline directory ${baselineDir} (WELES_BASELINE_DIR)`);
      return;
    }
    const { path: baselinePath, data: baseline } = pickBaseline(baselineDir, payload);
    let report = analyze(payload, baseline);
    report.meta.subjectPath = fpPath;
    report.meta.baselinePath = baselinePath;
    // A drift that cannot be compared is said, and the report keeps every finding.
    let pskDrift = false;
    try {
      pskDrift = compareDrift(s.label, network);
    } catch (error) {
      console.log(`[wsession] network drift compare error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (pskDrift) {
      const before = report.summary.totalFindings;
      report = withoutPskFindings(report);
      console.log(`[wsession] PSK drift explained: removed TLS mismatch findings, ${before} -> ${report.summary.totalFindings}`);
    }
    const reportPath = join(recordingsDir(s.label), 'detection_report.json');
    writeFileSync(reportPath, JSON.stringify(report, null, JSON_INDENT));
    console.log(`[wsession] detection report saved ${reportPath} critical=${report.summary.critical} warning=${report.summary.warning}`);
  } catch (error) {
    console.log(`[wsession] fingerprint capture error: ${error instanceof Error ? error.message : String(error)}`);
  }
}
