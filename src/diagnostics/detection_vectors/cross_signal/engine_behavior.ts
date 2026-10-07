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
      if (s?.js?.performance?.sampling !== b?.js?.performance?.sampling) {
        return {
          id: 'performance_timing_regular',
          category: 'behavior',
          severity: 'info',
          message:
            'Clock observations use different collection methods. Collect a baseline with the same probe revision before comparing them.',
          evidence: {
            subjectSampling: s?.js?.performance?.sampling,
            baselineSampling: b?.js?.performance?.sampling,
          },
        };
      }
      // Compare observed frame boundaries only against the same collection method.
      // A zero delta in both captures is not evidence against the subject.
      if (smin < 0.001 && (typeof bmin !== 'number' || bmin > 0.001)) {
        const baselineHint =
          typeof bmin === 'number'
            ? ` (baseline minDelta=${bmin.toFixed(3)})`
            : '';
        return {
          id: 'performance_timing_regular',
          category: 'behavior',
          severity: 'warning',
          message: `performance.now() minDelta is ${smin.toFixed(4)}${baselineHint}. Suggests clamped/intercepted timing.`,
          evidence: {
            subjectMinDelta: smin,
            baselineMinDelta: bmin,
            subjectSamples: s?.js?.performance?.nowSamples,
          },
        };
      }
      return null;
    },
  },
];
