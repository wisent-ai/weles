/**
 * Does `navigator` describe a browser somebody actually installed and used?
 *
 * These are the oldest and bluntest tells: the WebDriver flag the protocol
 * sets on itself, the HeadlessChrome token a stock headless build leaves in
 * its User-Agent, and the plugin/PDF surface that stealth patches routinely
 * strip out. They change together whenever a driver or a stealth patch
 * changes what it forgets to hide, which is a different clock from the GPU,
 * network or timing families.
 *
 * The family also owns the baseline-comparability check. It is filed here
 * because it reads the same `navigator.userAgent` string as its neighbours,
 * and because an operator who sees a plugin diff needs to know in the same
 * breath whether the two captures were even taken on the same OS.
 */

import type { DetectionRule } from '../finding.js';
import { browserFromUA, osFromUA } from '../persona_identity.js';

export const navigatorSurfaceRules: DetectionRule[] = [
  // ---------------------------------------------------------------------------
  // navigator
  // ---------------------------------------------------------------------------
  {
    id: 'nav_webdriver',
    name: 'navigator.webdriver flag',
    category: 'navigator',
    severity: 'critical',
    test(s) {
      if (s?.js?.navigator?.webdriver === true) {
        return {
          id: 'nav_webdriver',
          category: 'navigator',
          severity: 'critical',
          message: 'navigator.webdriver is true — the canonical automation tell.',
          evidence: { webdriver: true },
        };
      }
      return null;
    },
  },
  {
    id: 'headless_chrome_ua',
    name: 'HeadlessChrome token in User-Agent',
    category: 'navigator',
    severity: 'critical',
    test(s) {
      const ua = String(s?.js?.navigator?.userAgent || '').toLowerCase();
      if (ua.includes('headlesschrome')) {
        return {
          id: 'headless_chrome_ua',
          category: 'navigator',
          severity: 'critical',
          message: 'User-Agent contains "HeadlessChrome" — immediate block on Cloudflare / PerimeterX / Akamai.',
          evidence: { userAgent: s?.js?.navigator?.userAgent },
        };
      }
      return null;
    },
  },
  {
    id: 'nav_plugins_empty',
    name: 'navigator.plugins empty',
    category: 'navigator',
    severity: 'warning',
    test(s, b) {
      const sLen = Array.isArray(s?.js?.navigator?.plugins) ? s.js.navigator.plugins.length : null;
      const bLen = Array.isArray(b?.js?.navigator?.plugins) ? b.js.navigator.plugins.length : null;
      if (sLen === 0 && (bLen ?? 0) > 0) {
        return {
          id: 'nav_plugins_empty',
          category: 'navigator',
          severity: 'warning',
          message: `navigator.plugins is empty (${bLen} expected). Headless/stealth builds often strip plugins.`,
          evidence: { subjectPlugins: sLen, baselinePlugins: bLen },
        };
      }
      return null;
    },
  },
  {
    id: 'nav_plugins_length_mismatch',
    name: 'navigator.plugins length mismatch',
    category: 'navigator',
    severity: 'info',
    test(s, b) {
      const sLen = Array.isArray(s?.js?.navigator?.plugins) ? s.js.navigator.plugins.length : null;
      const bLen = Array.isArray(b?.js?.navigator?.plugins) ? b.js.navigator.plugins.length : null;
      if (sLen !== null && bLen !== null && sLen !== bLen && sLen !== 0) {
        return {
          id: 'nav_plugins_length_mismatch',
          category: 'navigator',
          severity: 'info',
          message: `navigator.plugins length differs (${sLen} vs ${bLen}).`,
          evidence: { subjectPlugins: sLen, baselinePlugins: bLen },
        };
      }
      return null;
    },
  },
  {
    id: 'nav_pdf_viewer',
    name: 'navigator.pdfViewerEnabled mismatch',
    category: 'navigator',
    severity: 'info',
    test(s, b) {
      const sv = s?.js?.navigator?.pdfViewerEnabled;
      const bv = b?.js?.navigator?.pdfViewerEnabled;
      if (sv !== undefined && bv !== undefined && sv !== bv) {
        return {
          id: 'nav_pdf_viewer',
          category: 'navigator',
          severity: 'info',
          message: `navigator.pdfViewerEnabled differs (${sv} vs ${bv}).`,
          evidence: { subject: sv, baseline: bv },
        };
      }
      return null;
    },
  },
  {
    id: 'baseline_family_mismatch',
    name: 'Baseline OS/browser family mismatch',
    category: 'inconsistency',
    severity: 'info',
    test(s, b) {
      const sUA = String(s?.js?.navigator?.userAgent || '');
      const bUA = String(b?.js?.navigator?.userAgent || '');
      const sOS = osFromUA(sUA), bOS = osFromUA(bUA);
      const sBr = browserFromUA(sUA), bBr = browserFromUA(bUA);
      if ((sOS && bOS && sOS !== bOS) || (sBr && bBr && sBr !== bBr)) {
        return {
          id: 'baseline_family_mismatch',
          category: 'inconsistency',
          severity: 'info',
          message: `Subject is ${sOS}/${sBr} but baseline is ${bOS}/${bBr}. Cross-family diffs (WebGL, JA4, screen depth) may be expected; capture a baseline on the same OS/browser for an apples-to-apples comparison.`,
          evidence: { subject: { os: sOS, browser: sBr }, baseline: { os: bOS, browser: bBr } },
        };
      }
      return null;
    },
  },
];
