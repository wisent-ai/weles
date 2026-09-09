/**
 * Does the JavaScript engine behave like the engine it says it is?
 *
 * Everything else in the registry compares values the page hands out. These
 * two compare behaviour: the shape of a thrown Error's stack, which is a
 * V8/SpiderMonkey dialect, and the granularity of `performance.now()`, which
 * exposes clamping or interception of the clock.
 *
 * Behavioural probes need their own module because their evidence is only
 * meaningful relative to a baseline that measured the same way. The timing
 * rule encodes that caution directly: when the baseline also reports a zero
 * delta the probe itself is untrustworthy on that engine and the rule stays
 * silent rather than manufacturing a signal.
 */

import type { DetectionRule } from '../finding.js';

export const engineBehaviorRules: DetectionRule[] = [
  // ---------------------------------------------------------------------------
  // JS engine / behavior
  // ---------------------------------------------------------------------------
  {
    id: 'error_stack_format',
    name: 'Error stack format mismatch',
    category: 'behavior',
    severity: 'info',
    test(s, b) {
      const ss = s?.js?.errorStack;
      const bs = b?.js?.errorStack;
      if (ss && bs && ss.stackLines !== bs.stackLines) {
        return {
          id: 'error_stack_format',
          category: 'behavior',
          severity: 'info',
          message: `Error stack line count differs (${ss.stackLines} vs ${bs.stackLines}).`,
          evidence: { subject: ss, baseline: bs },
        };
      }
      return null;
    },
  },
  {
    id: 'performance_timing_regular',
    name: 'performance.now() increments absent',
    category: 'behavior',
    severity: 'warning',
    test(s, b) {
      const smin = s?.js?.performance?.nowMinDelta;
      const bmin = b?.js?.performance?.nowMinDelta;
      if (typeof smin !== 'number') return null;
      // A real browser with 5–15 ms gaps between samples must show positive deltas.
      // If the baseline also shows 0, the probe measurement is unreliable for this
      // engine and we should not flag it as a detection signal.
      if (smin < 0.001 && (typeof bmin !== 'number' || bmin > 0.001)) {
        const baselineHint = typeof bmin === 'number' ? ` (baseline minDelta=${bmin.toFixed(3)})` : '';
        return {
          id: 'performance_timing_regular',
          category: 'behavior',
          severity: 'warning',
          message: `performance.now() minDelta is ${smin.toFixed(4)}${baselineHint}. Suggests clamped/intercepted timing.`,
          evidence: { subjectMinDelta: smin, baselineMinDelta: bmin, subjectSamples: s?.js?.performance?.nowSamples },
        };
      }
      return null;
    },
  },
];
