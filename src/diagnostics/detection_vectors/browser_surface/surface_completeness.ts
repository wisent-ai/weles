/**
 * Is the optional API surface as complete as a headed install's?
 *
 * Automation strips the parts of a browser nobody thinks of as load-bearing:
 * the toolbar above the viewport, the speech-synthesis voice list the OS
 * supplies, the battery and connection objects, the legacy `chrome.loadTimes`
 * and `chrome.csi` shims, and simply the number of globals on `window`. None
 * of these matters to a page that wants to render; all of them matter to a
 * detector counting what is absent.
 *
 * Three judgements are encoded here. A headed Chrome puts more than two pixels
 * of toolbar between outerHeight and innerHeight, so two or fewer reads as
 * headless. Zero speech voices where the baseline has any means the OS speech
 * stack was never wired up. And a window carrying under 92% of the baseline's
 * own-property count is a stripped context — the margin leaves room for
 * legitimate version drift between two captures without excusing a wholesale
 * gap.
 *
 * The family is separate from the automation-marker family because it detects
 * subtraction rather than addition: nothing was added to give the subject
 * away, something was quietly never built.
 */

import type { DetectionRule } from '../finding.js';

export const surfaceCompletenessRules: DetectionRule[] = [
  // ---------------------------------------------------------------------------
  // Browser surface completeness (automation often strips these)
  // ---------------------------------------------------------------------------
  {
    id: 'screen_toolbar_height',
    name: 'Browser toolbar height suggests headless/automation',
    category: 'screen',
    severity: 'warning',
    test(s, b) {
      const st = s?.js?.window?.chromeToolbarPx;
      const bt = b?.js?.window?.chromeToolbarPx;
      if (typeof st === 'number' && typeof bt === 'number' && bt > 2 && st <= 2) {
        return {
          id: 'screen_toolbar_height',
          category: 'screen',
          severity: 'warning',
          message: `window.outerHeight - innerHeight is ${st}px (baseline ${bt}px). A headed Chrome has a toolbar > 0px; 0px is a headless/automation tell.`,
          evidence: { subjectToolbarPx: st, baselineToolbarPx: bt },
        };
      }
      return null;
    },
  },
  {
    id: 'speech_voices_empty',
    name: 'speechSynthesis voices list empty',
    category: 'navigator',
    severity: 'warning',
    test(s, b) {
      const sc = s?.js?.speechVoices?.count;
      const bc = b?.js?.speechVoices?.count;
      if (sc === 0 && (bc ?? 0) > 0) {
        return {
          id: 'speech_voices_empty',
          category: 'navigator',
          severity: 'warning',
          message: `speechSynthesis.getVoices() returned 0 voices (${bc} expected). Headless/ stripped builds often have no voices.`,
          evidence: { subjectVoices: sc, baselineVoices: bc },
        };
      }
      return null;
    },
  },
  {
    id: 'battery_api_missing',
    name: 'navigator.getBattery missing',
    category: 'navigator',
    severity: 'info',
    test(s, b) {
      const sb = s?.js?.battery;
      const bb = b?.js?.battery;
      if (bb !== null && bb !== undefined && (sb === null || sb === undefined)) {
        return {
          id: 'battery_api_missing',
          category: 'navigator',
          severity: 'info',
          message: 'navigator.getBattery is missing on subject while baseline exposes it.',
          evidence: { subjectBattery: sb, baselineBattery: bb },
        };
      }
      return null;
    },
  },
  {
    id: 'network_information_missing',
    name: 'navigator.connection missing',
    category: 'navigator',
    severity: 'info',
    test(s, b) {
      const sc = s?.js?.navigator?.connection;
      const bc = b?.js?.navigator?.connection;
      if (bc !== null && bc !== undefined && (sc === null || sc === undefined)) {
        return {
          id: 'network_information_missing',
          category: 'navigator',
          severity: 'info',
          message: 'navigator.connection is missing on subject while baseline exposes it.',
          evidence: { subjectConnection: sc, baselineConnection: bc },
        };
      }
      return null;
    },
  },
  {
    id: 'chrome_loadtimes_missing',
    name: 'chrome.loadTimes / chrome.csi missing',
    category: 'navigator',
    severity: 'warning',
    test(s, b) {
      const sc = s?.js?.chrome;
      const bc = b?.js?.chrome;
      if (bc?.loadTimes === true && sc?.loadTimes !== true) {
        return {
          id: 'chrome_loadtimes_missing',
          category: 'navigator',
          severity: 'warning',
          message: 'chrome.loadTimes is missing on Chromium. Some anti-bot scripts check this legacy Chrome API.',
          evidence: { subjectChrome: sc, baselineChrome: bc },
        };
      }
      if (bc?.csi === true && sc?.csi !== true) {
        return {
          id: 'chrome_loadtimes_missing',
          category: 'navigator',
          severity: 'warning',
          message: 'chrome.csi is missing on Chromium. Some anti-bot scripts check this legacy Chrome API.',
          evidence: { subjectChrome: sc, baselineChrome: bc },
        };
      }
      return null;
    },
  },
  {
    id: 'window_ownprops_count_low',
    name: 'window own-property count suspiciously low',
    category: 'inconsistency',
    severity: 'info',
    test(s, b) {
      const sc = s?.js?.ownPropsCount;
      const bc = b?.js?.ownPropsCount;
      if (typeof sc === 'number' && typeof bc === 'number' && bc > 0 && sc < bc * 0.92) {
        return {
          id: 'window_ownprops_count_low',
          category: 'inconsistency',
          severity: 'info',
          message: `window has ${sc} own properties vs baseline ${bc}. Stripped automation contexts often expose fewer globals.`,
          evidence: { subjectOwnPropsCount: sc, baselineOwnPropsCount: bc },
        };
      }
      return null;
    },
  },
];
