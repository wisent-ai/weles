/**
 * Does this look like a profile somebody has lived in, or a fresh container?
 *
 * PerimeterX-class detectors read a cluster of signals that no automation
 * script sets deliberately and that accumulate only through ordinary use: the
 * permission states a user has been prompted for, the presence of the
 * `window.chrome` object a real Chromium install carries, and the font
 * inventory an operating system builds up. A brand-new container answers all
 * of them the same suspicious way at once.
 *
 * The font threshold encodes that judgement: fewer than four detected faces,
 * where the baseline machine reports at least four, is the point at which a
 * font list stops looking like a desktop and starts looking like a stripped
 * base image. It is a provenance question, not an API-correctness one, which
 * is why these rules are not filed with the surface-completeness family.
 */

import type { DetectionRule } from '../finding.js';

export const profileProvenanceRules: DetectionRule[] = [
  {
    id: 'notification_permission_unexpected',
    name: 'Notification.permission unexpected value',
    category: 'navigator',
    severity: 'warning',
    test(s, b) {
      const sp = s?.js?.notification?.permission;
      const bp = b?.js?.notification?.permission;
      if (sp !== undefined && bp !== undefined && sp !== bp) {
        return {
          id: 'notification_permission_unexpected',
          category: 'navigator',
          severity: 'warning',
          message: `Notification.permission is "${sp}" (baseline "${bp}"). "granted" on a fresh profile is suspicious.`,
          evidence: { subjectPermission: sp, baselinePermission: bp },
        };
      }
      return null;
    },
  },
  {
    id: 'permissions_query_mismatch',
    name: 'navigator.permissions.query state mismatch',
    category: 'navigator',
    severity: 'info',
    test(s, b) {
      const sp = s?.js?.permissions;
      const bp = b?.js?.permissions;
      if (!sp || !bp || typeof sp !== 'object' || typeof bp !== 'object') return null;
      for (const k of Object.keys(sp)) {
        if (bp[k] !== undefined && sp[k] !== bp[k] && sp[k] !== 'unsupported') {
          return {
            id: 'permissions_query_mismatch',
            category: 'navigator',
            severity: 'info',
            message: `Permission "${k}" state differs (${sp[k]} vs ${bp[k]}).`,
            evidence: { permission: k, subject: sp[k], baseline: bp[k] },
          };
        }
      }
      return null;
    },
  },
  {
    id: 'chrome_global_missing',
    name: 'window.chrome object missing',
    category: 'navigator',
    severity: 'warning',
    test(s, b) {
      const sc = s?.js?.chrome;
      const bc = b?.js?.chrome;
      if (bc?.exists === true && sc?.exists !== true) {
        return {
          id: 'chrome_global_missing',
          category: 'navigator',
          severity: 'warning',
          message: 'window.chrome is missing on Chromium. Bot detectors check for chrome.* globals.',
          evidence: { subjectChrome: sc, baselineChrome: bc },
        };
      }
      return null;
    },
  },
  {
    id: 'font_list_minimal',
    name: 'Font list looks minimal/containerized',
    category: 'inconsistency',
    severity: 'warning',
    test(s, b) {
      const countPresent = (obj: any) => Object.values(obj || {}).filter(v => v === true).length;
      const sCount = countPresent(s?.js?.fonts);
      const bCount = countPresent(b?.js?.fonts);
      if (sCount < 4 && bCount >= 4) {
        return {
          id: 'font_list_minimal',
          category: 'inconsistency',
          severity: 'warning',
          message: `Only ${sCount} fonts detected (${bCount} in baseline). Container/headless environments often have a stripped font list.`,
          evidence: { subjectFontCount: sCount, baselineFontCount: bCount, subjectFonts: s?.js?.fonts },
        };
      }
      return null;
    },
  },
];
