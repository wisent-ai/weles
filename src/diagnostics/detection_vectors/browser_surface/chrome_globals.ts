/**
 * Did the automation stack leave its own objects lying on the page?
 *
 * Two mirror-image checks. `chrome.runtime` is something a real Chromium has
 * and a stripped or non-Chromium build does not; the distinctive-property
 * sweep is the opposite — names that only a driver, a stealth patch or an
 * instrumentation harness ever adds to `window` or `document`.
 *
 * Both read the injected-object layer rather than any standard Web API, which
 * is why they are one family: they change whenever a driver or a patch set
 * changes its own footprint, and they are the checks an operator must clear
 * before any other finding in the report is worth reading.
 */

import type { DetectionRule } from '../finding.js';

export const chromeGlobalsRules: DetectionRule[] = [
  // ---------------------------------------------------------------------------
  // chrome globals / automation markers
  // ---------------------------------------------------------------------------
  {
    id: 'chrome_runtime_missing',
    name: 'chrome.runtime missing',
    category: 'navigator',
    severity: 'warning',
    test(s, b) {
      const sc = s?.js?.chrome;
      const bc = b?.js?.chrome;
      if (bc?.runtime === true && sc?.runtime !== true) {
        return {
          id: 'chrome_runtime_missing',
          category: 'navigator',
          severity: 'warning',
          message: `chrome.runtime is missing on Chromium. Some sites test this.`,
          evidence: { subjectChrome: sc, baselineChrome: bc },
        };
      }
      return null;
    },
  },
  {
    id: 'automation_window_props',
    name: 'Automation markers in window properties',
    category: 'navigator',
    severity: 'critical',
    test(s) {
      const hits = s?.js?.distinctivePropsHits;
      if (!hits || typeof hits !== 'object') return null;
      const keys = Object.keys(hits).filter(k => hits[k] && (hits[k].window?.length || hits[k].document?.length));
      if (keys.length) {
        return {
          id: 'automation_window_props',
          category: 'navigator',
          severity: 'critical',
          message: `Automation markers detected in window/document properties: ${keys.join(', ')}.`,
          evidence: { hits: keys.map(k => ({ name: k, ...hits[k] })) },
        };
      }
      return null;
    },
  },
];
