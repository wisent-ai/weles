#!/usr/bin/env node
// CLI for the fingerprint analyzer.
//
// Compare a Weles fingerprint JSON (subject) against a real-browser baseline.
// If a directory is passed as baseline, the best matching baseline is selected
// by OS/browser family.
//
// Usage:
//   node scripts/diagnostics/analyze_fingerprint.mjs <subject.json> [baseline.json|baselineDir]
//   node scripts/diagnostics/analyze_fingerprint.mjs recordings/local_fingerprint_chromium.json recordings/baselines
//   REPORT_JSON=out.json node scripts/diagnostics/analyze_fingerprint.mjs subject.json baseline.json

import { lstatSync } from 'node:fs';
import { analyze, loadJson, pickBaseline, printReport } from '../../dist/diagnostics/fingerprint_analyzer.js';

const subjectPath = process.argv[2];
const baselineArg = process.argv[3];

if (!subjectPath) {
  console.error('Usage: analyze_fingerprint.mjs <subject.json> [baseline.json|baselineDir]');
  process.exit(1);
}

const subject = loadJson(subjectPath);
let baselinePath;
let baseline;

if (!baselineArg) {
  baselinePath = 'recordings/baselines';
  ({ path: baselinePath, data: baseline } = pickBaseline(baselinePath, subject));
} else if (lstatSync(baselineArg).isDirectory()) {
  ({ path: baselinePath, data: baseline } = pickBaseline(baselineArg, subject));
} else {
  baselinePath = baselineArg;
  baseline = loadJson(baselinePath);
}

const report = analyze(subject, baseline);
report.meta.subjectPath = subjectPath;
report.meta.baselinePath = baselinePath;

printReport(report);

if (process.env.REPORT_JSON) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(process.env.REPORT_JSON, JSON.stringify(report, null, 2));
  console.log(`Report JSON saved to ${process.env.REPORT_JSON}`);
}

process.exit(report.summary.critical > 0 ? 2 : report.summary.warning > 0 ? 1 : 0);
