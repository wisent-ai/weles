/**
 * Fingerprint analyzer: compares a Weles (subject) fingerprint against
 * real-browser baselines using the detection-vector rule registry.
 *
 * Produces a ranked list of concrete detection signals so operators no
 * longer have to guess why an automation run was blocked.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { getDetectionRules, Finding, FindingSeverity } from './detection_vectors.js';

export interface FingerprintReport {
  meta: {
    subjectPath: string;
    baselinePath: string;
    baselineMatched: boolean;
    subjectOS: string | null;
    baselineOS: string | null;
    subjectBrowser: string | null;
    baselineBrowser: string | null;
    pskDriftExplained?: boolean;
  };
  summary: {
    totalFindings: number;
    critical: number;
    warning: number;
    info: number;
    riskScore: number;
    byCategory: Record<string, number>;
  };
  findings: Finding[];
}

const SEVERITY_WEIGHT: Record<FindingSeverity, number> = {
  critical: 10,
  warning: 5,
  info: 2,
};

function osFromUA(ua: string): string | null {
  const u = ua.toLowerCase();
  if (u.includes('macintosh') || u.includes('mac os')) return 'macos';
  if (u.includes('windows nt')) return 'windows';
  if (u.includes('linux') || u.includes('x11')) return 'linux';
  return null;
}

function browserFromUA(ua: string): string | null {
  const u = ua.toLowerCase();
  if (u.includes('firefox') && !u.includes('seamonkey')) return 'firefox';
  if (u.includes('chrome') && !u.includes('edg') && !u.includes('opr')) return 'chrome';
  if (u.includes('safari') && !u.includes('chrome')) return 'safari';
  if (u.includes('edg')) return 'edge';
  return null;
}

export function loadJson(path: string): any {
  if (!existsSync(path)) {
    throw new Error(`Fingerprint file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * Pick the best baseline from a directory based on OS and browser family.
 * Baseline files should end with `.json` and contain at least a UA string.
 */
export function pickBaseline(baselineDir: string, subject: any): { path: string; data: any } {
  const files = readdirSync(baselineDir)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => join(baselineDir, f));

  if (files.length === 0) {
    throw new Error(`No baseline JSON files in ${baselineDir}`);
  }

  const subjectUA = String(subject?.js?.navigator?.userAgent || '');
  const subjectOS = osFromUA(subjectUA);
  const subjectBrowser = browserFromUA(subjectUA);

  const subjectHeadless = subjectUA.toLowerCase().includes('headless');

  let best: { path: string; data: any; score: number } | null = null;
  for (const p of files) {
    const data = loadJson(p);
    const ua = String(data?.js?.navigator?.userAgent || '');
    const os = osFromUA(ua);
    const browser = browserFromUA(ua);
    const baselineHeadless = ua.toLowerCase().includes('headless');
    let score = 0;
    if (os && os === subjectOS) score += 2;
    if (browser && browser === subjectBrowser) score += 2;
    if (baselineHeadless === subjectHeadless) score += 1;
    if (!baselineHeadless && !subjectHeadless) score += 1;
    if (!best || score > best.score || (score === best.score && p > best.path)) {
      best = { path: p, data, score };
    }
  }

  return { path: best!.path, data: best!.data };
}

export function analyze(subject: any, baseline: any): FingerprintReport {
  const rules = getDetectionRules();
  const findings: Finding[] = [];

  for (const rule of rules) {
    try {
      const finding = rule.test(subject, baseline);
      if (finding) findings.push(finding);
    } catch (err) {
      findings.push({
        id: `${rule.id}_error`,
        category: rule.category,
        severity: 'info',
        message: `Rule ${rule.id} threw: ${(err as Error).message}`,
        evidence: { error: (err as Error).message },
      });
    }
  }

  findings.sort((a, b) => SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity]);

  const counts = { critical: 0, warning: 0, info: 0 };
  const byCategory: Record<string, number> = {};
  let riskScore = 0;
  for (const f of findings) {
    counts[f.severity]++;
    riskScore += SEVERITY_WEIGHT[f.severity];
    byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  }

  const subjectUA = String(subject?.js?.navigator?.userAgent || '');
  const baselineUA = String(baseline?.js?.navigator?.userAgent || '');
  const subjectOS = osFromUA(subjectUA);
  const baselineOS = osFromUA(baselineUA);
  const subjectBrowser = browserFromUA(subjectUA);
  const baselineBrowser = browserFromUA(baselineUA);
  const baselineMatched = subjectOS === baselineOS && subjectBrowser === baselineBrowser;

  return {
    meta: {
      subjectPath: '',
      baselinePath: '',
      baselineMatched,
      subjectOS,
      baselineOS,
      subjectBrowser,
      baselineBrowser,
    },
    summary: {
      totalFindings: findings.length,
      ...counts,
      riskScore,
      byCategory,
    },
    findings,
  };
}

export function printReport(report: FingerprintReport): void {
  console.log('');
  console.log('=== Fingerprint Analysis Report ===');
  console.log(`Subject : ${report.meta.subjectPath || '<in-memory>'}`);
  console.log(`Baseline: ${report.meta.baselinePath || '<in-memory>'}`);
  console.log(`Baseline matched family: ${report.meta.baselineMatched ? 'yes' : 'NO'}`);
  console.log(`Subject  OS/Browser: ${report.meta.subjectOS} / ${report.meta.subjectBrowser}`);
  console.log(`Baseline OS/Browser: ${report.meta.baselineOS} / ${report.meta.baselineBrowser}`);
  if (!report.meta.baselineMatched) {
    console.log('WARNING: baseline family mismatch — cross-family differences (WebGL GPU, JA4, screen depth) are expected. Capture a baseline on the same OS/browser for a valid comparison.');
  }
  console.log('');
  console.log(`Total findings: ${report.summary.totalFindings}`);
  console.log(`  Critical: ${report.summary.critical}`);
  console.log(`  Warning : ${report.summary.warning}`);
  console.log(`  Info    : ${report.summary.info}`);
  console.log(`Risk score : ${report.summary.riskScore}`);
  console.log('By category:');
  for (const [cat, n] of Object.entries(report.summary.byCategory)) {
    console.log(`  ${cat}: ${n}`);
  }
  console.log('');
  if (report.findings.length === 0) {
    console.log('No detection vectors identified. Fingerprint looks consistent with baseline.');
  } else {
    for (let i = 0; i < report.findings.length; i++) {
      const f = report.findings[i];
      console.log(`#${i + 1} [${f.severity.toUpperCase()}] ${f.id} (${f.category})`);
      console.log(`    ${f.message}`);
      console.log(`    Evidence: ${JSON.stringify(f.evidence)}`);
    }
  }
  console.log('');
}
