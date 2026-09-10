// The fingerprint a closing session records for itself: the probe script
// run in the page, the network-side fingerprint, and the analysis against
// the baseline the persona was drawn from. Split out of finalize.ts.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FP_SCRIPT, NETWORK_FP_URL, parseNetworkFingerprint } from '../../../diagnostics/fingerprint_probe.js';
import { analyze, pickBaseline } from '../../../diagnostics/fingerprint_analyzer.js';
import type { WSession } from '../../wsession.js';
import { runRecordingsDir, runRecordingsRoot } from '../../run-recordings.js';

export function recordingsDir(label?: string): string {
  return label ? runRecordingsDir(label) : runRecordingsRoot();
}

export async function wsCaptureFingerprint(s: WSession): Promise<void> {
  if (!s.label) return;
  if (process.env.WELES_FINGERPRINT === '0') return;
  try {
    const js = await s.page.evaluate(FP_SCRIPT);
    let network: any = null;
    try {
      await s.page.goto(NETWORK_FP_URL, { waitUntil: 'domcontentloaded' });
      const raw = await s.page.evaluate(`document.body.innerText || document.body.textContent || ''`);
      network = parseNetworkFingerprint(raw);
    } catch (e: any) {
      network = { _err: String(e?.message ?? e).slice(0, 200) };
    }
    const payload = {
      capturedAt: new Date().toISOString(),
      source: 'weles-auto',
      browser: (s as any)._browserProvenance?.browser ?? 'unknown',
      js,
      network,
    };
    const fpPath = join(recordingsDir(s.label), 'fingerprint.json');
    writeFileSync(fpPath, JSON.stringify(payload, null, 2));
    console.log(`[wsession] fingerprint saved ${fpPath}`);

    const baselineDir = process.env.WELES_BASELINE_DIR || join(process.cwd(), 'recordings', 'baselines');
    if (existsSync(baselineDir)) {
      const { path: baselinePath, data: baseline } = pickBaseline(baselineDir, payload);
      let report = analyze(payload, baseline);
      report.meta.subjectPath = fpPath;
      report.meta.baselinePath = baselinePath;

      // Detect network fingerprint drift between early (pre-action) and final
      // (close-time) captures. If the only change is the appearance of the TLS
      // 1.3 pre_shared_key extension after the target site was visited, the
      // drift is expected session resumption — not a detection signal. The
      // target saw the early JA4; the close-time JA4 is a measurement artifact.
      const earlyPath = join(recordingsDir(s.label), 'early_fingerprint.json');
      let pskDrift = false;
      const driftFields: string[] = [];
      if (existsSync(earlyPath)) {
        try {
          const early = JSON.parse(readFileSync(earlyPath, 'utf-8'));
          const earlyExts = new Set((early?.network?.extensions || []) as string[]);
          const finalExts = new Set((network?.extensions || []) as string[]);
          const isGrease = (x: string) => x.startsWith('TLS_GREASE');
          const added = [...finalExts].filter((x) => !earlyExts.has(x) && !isGrease(x));
          const removed = [...earlyExts].filter((x) => !finalExts.has(x) && !isGrease(x));
          pskDrift = added.length === 1 && added[0] === 'pre_shared_key (41)' && removed.length === 0;
          for (const f of ['ja4', 'peetprint_hash', 'akamaiH2'] as const) {
            const e = early?.network?.[f] ?? null;
            const fin = network?.[f] ?? null;
            if (e && fin && e !== fin) driftFields.push(f);
          }
          if (driftFields.length) {
            const drift: Record<string, { early: string | null; final: string | null; pskExpected?: boolean }> = {};
            for (const f of driftFields) {
              drift[f] = { early: early?.network?.[f] ?? null, final: network?.[f] ?? null, pskExpected: pskDrift };
            }
            const driftPath = join(recordingsDir(s.label), 'network_drift.json');
            writeFileSync(driftPath, JSON.stringify({ capturedAt: new Date().toISOString(), pskDrift, drift }, null, 2));
            console.log(`[wsession] network drift detected: ${driftFields.join(', ')}${pskDrift ? ' (expected PSK resumption)' : ''} — saved ${driftPath}`);
          }
        } catch (e: any) {
          console.log(`[wsession] network drift compare error: ${e?.message?.slice(0, 200)}`);
        }
      }

      if (pskDrift) {
        const pskFindingIds = new Set(['tls_ja4_mismatch', 'tls_peetprint_mismatch']);
        const before = report.summary.riskScore;
        report.findings = report.findings.filter((f) => !pskFindingIds.has(f.id));
        // Recompute summary.
        const counts = { critical: 0, warning: 0, info: 0 };
        const byCategory: Record<string, number> = {};
        const SEVERITY_WEIGHT: Record<string, number> = { critical: 10, warning: 5, info: 2 };
        let riskScore = 0;
        for (const f of report.findings) {
          counts[f.severity]++;
          riskScore += SEVERITY_WEIGHT[f.severity];
          byCategory[f.category] = (byCategory[f.category] || 0) + 1;
        }
        report.summary = { totalFindings: report.findings.length, ...counts, riskScore, byCategory };
        report.meta.pskDriftExplained = true;
        console.log(`[wsession] PSK drift explained: removed TLS mismatch findings, risk ${before} -> ${report.summary.riskScore}`);
      }

      const reportPath = join(recordingsDir(s.label), 'detection_report.json');
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`[wsession] detection report saved ${reportPath} risk=${report.summary.riskScore} critical=${report.summary.critical}`);
    }
  } catch (e: any) {
    console.log(`[wsession] fingerprint capture error: ${e?.message?.slice(0, 200)}`);
  }
}

