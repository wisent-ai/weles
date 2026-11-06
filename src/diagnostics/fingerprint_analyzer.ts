/**
 * Fingerprint analyzer: compares a Weles (subject) fingerprint against a
 * real-browser baseline of the same platform and vendor using the
 * detection-vector rule registry.
 *
 * Produces the concrete detection signals so operators no longer have to
 * guess why an automation run was blocked. Findings are counted per severity;
 * no weighted score is made up from them, because nothing defines how much a
 * warning is worth against a critical finding.
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  getDetectionRules,
  Finding,
  FindingSeverity,
} from './detection_vectors.js';

/**
 * The browser family a fingerprint was captured in, as the page itself
 * reported it: navigator.platform and navigator.vendor, compared whole.
 */
export interface BrowserFamily {
  platform: string | null;
  vendor: string | null;
}

export interface FingerprintSummary {
  totalFindings: number;
  critical: number;
  warning: number;
  info: number;
  byCategory: Record<string, number>;
}

export interface FingerprintReport {
  meta: {
    subjectPath: string;
    baselinePath: string;
    subjectFamily: BrowserFamily;
    baselineFamily: BrowserFamily;
    pskDriftExplained?: boolean;
  };
  summary: FingerprintSummary;
  findings: Finding[];
}

function familyOf(fingerprint: any): BrowserFamily {
  const navigator = fingerprint?.js?.navigator;
  const platform =
    typeof navigator?.platform === 'string' ? navigator.platform : null;
  const vendor =
    typeof navigator?.vendor === 'string' ? navigator.vendor : null;
  return { platform, vendor };
}

function sameFamily(left: BrowserFamily, right: BrowserFamily): boolean {
  return left.platform === right.platform && left.vendor === right.vendor;
}

function described(family: BrowserFamily): string {
  return `platform ${JSON.stringify(family.platform)}, vendor ${JSON.stringify(family.vendor)}`;
}

export function loadJson(path: string): any {
  if (!existsSync(path)) {
    throw new Error(`Fingerprint file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf-8'));
}

/**
 * The baseline in `baselineDir` captured in the subject's own browser family
 * (the same navigator.platform and navigator.vendor); the most recently
 * captured one when several are. A directory with none of that family is
 * refused naming the subject's family and every family it holds, since a
 * cross-family comparison reports the family difference, not a detection.
 */
export function pickBaseline(
  baselineDir: string,
  subject: any,
): { path: string; data: any } {
  const candidates = readdirSync(baselineDir)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => {
      const path = join(baselineDir, f);
      return { path, data: loadJson(path) };
    });
  if (!candidates.length) {
    throw new Error(`No baseline JSON files in ${baselineDir}`);
  }
  const subjectFamily = familyOf(subject);
  const matching = candidates
    .filter((candidate) => sameFamily(familyOf(candidate.data), subjectFamily))
    .sort((left, right) =>
      String(right.data?.capturedAt).localeCompare(
        String(left.data?.capturedAt),
      ),
    );
  const [chosen] = matching;
  if (!chosen) {
    const held = [
      ...new Set(
        candidates.map((candidate) => described(familyOf(candidate.data))),
      ),
    ];
    throw new Error(
      `No baseline in ${baselineDir} was captured in the subject's browser family (${described(subjectFamily)}); it holds ${held.join('; ')}`,
    );
  }
  return chosen;
}

/** Findings grouped by severity, most severe first in the order the groups are declared. */
function bySeverity(findings: Finding[]): Record<FindingSeverity, Finding[]> {
  const groups: Record<FindingSeverity, Finding[]> = {
    critical: [],
    warning: [],
    info: [],
  };
  for (const finding of findings) groups[finding.severity].push(finding);
  return groups;
}

/** Findings counted per severity and per category. */
export function summarize(findings: Finding[]): FingerprintSummary {
  const groups = bySeverity(findings);
  const categories: Record<string, Finding[]> = {};
  for (const finding of findings) {
    if (!Object.hasOwn(categories, finding.category))
      categories[finding.category] = [];
    categories[finding.category].push(finding);
  }
  const byCategory = Object.fromEntries(
    Object.entries(categories).map(([category, members]) => [
      category,
      members.length,
    ]),
  );
  return {
    totalFindings: findings.length,
    critical: groups.critical.length,
    warning: groups.warning.length,
    info: groups.info.length,
    byCategory,
  };
}

export function analyze(subject: any, baseline: any): FingerprintReport {
  const findings: Finding[] = [];
  for (const rule of getDetectionRules()) {
    try {
      const finding = rule.test(subject, baseline);
      if (finding) findings.push(finding);
    } catch (err) {
      findings.push({
        id: `${rule.id}_error`,
        category: rule.category,
        severity: 'info',
        message: `Rule ${rule.id} could not judge: ${(err as Error).message}`,
        evidence: { error: (err as Error).message },
      });
    }
  }
  const ordered = Object.values(bySeverity(findings)).flat();
  return {
    meta: {
      subjectPath: '',
      baselinePath: '',
      subjectFamily: familyOf(subject),
      baselineFamily: familyOf(baseline),
    },
    summary: summarize(ordered),
    findings: ordered,
  };
}
