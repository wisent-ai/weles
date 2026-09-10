/**
 * What shape does a detection finding — and the rule that emits one — have?
 *
 * Every vector family in this package speaks the same vocabulary: a rule
 * compares a subject fingerprint against a real-browser baseline and either
 * stays quiet or returns a Finding. That vocabulary changes for its own
 * reason — a new category of tell, a new severity band, a richer evidence
 * payload — and not because any single family learned a new trick. Holding
 * it in its own module lets a family depend on the contract alone and never
 * on a sibling family, which is what keeps the families independent of each
 * other.
 */

export type FindingCategory =
  | 'navigator'
  | 'screen'
  | 'webgl'
  | 'canvas'
  | 'audio'
  | 'network'
  | 'behavior'
  | 'inconsistency';

export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  message: string;
  evidence: Record<string, unknown>;
}

export interface DetectionRule {
  id: string;
  name: string;
  category: FindingCategory;
  severity: FindingSeverity;
  test(subject: any, baseline: any): Finding | null;
}
