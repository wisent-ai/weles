/**
 * Does the reported display match the machine the persona claims to sit on?
 *
 * A display is a physical object, so its numbers are correlated in ways a
 * spoofer has to reproduce all at once: colour and pixel depth follow the
 * panel (Retina/HDR reports 30, not 24), availTop/availLeft follow the OS
 * chrome around the desktop, and a touch digitiser simply does not exist on a
 * desktop persona.
 *
 * These live with the device signals rather than with the browser surface
 * because they describe hardware, not the JS API surface: they change when a
 * new panel class or a new window manager appears, not when a driver leaks a
 * new marker.
 */

import type { DetectionRule } from '../finding.js';
import { OS_DESKTOP, osFromUA } from '../persona_identity.js';

export const screenGeometryRules: DetectionRule[] = [
  // ---------------------------------------------------------------------------
  // screen
  // ---------------------------------------------------------------------------
  {
    id: 'screen_color_depth',
    name: 'screen.colorDepth / pixelDepth mismatch',
    category: 'screen',
    severity: 'warning',
    test(s, b) {
      const sColor = s?.js?.screen?.colorDepth;
      const bColor = b?.js?.screen?.colorDepth;
      const sPixel = s?.js?.screen?.pixelDepth;
      const bPixel = b?.js?.screen?.pixelDepth;
      if ((sColor !== undefined && bColor !== undefined && sColor !== bColor) ||
          (sPixel !== undefined && bPixel !== undefined && sPixel !== bPixel)) {
        return {
          id: 'screen_color_depth',
          category: 'screen',
          severity: 'warning',
          message: `Screen depth differs (colorDepth ${sColor}/${bColor}, pixelDepth ${sPixel}/${bPixel}). macOS Retina/HDR should be 30/30.`,
          evidence: { subjectColorDepth: sColor, baselineColorDepth: bColor, subjectPixelDepth: sPixel, baselinePixelDepth: bPixel },
        };
      }
      return null;
    },
  },
  {
    id: 'screen_avail_top',
    name: 'screen.availTop / availLeft mismatch',
    category: 'screen',
    severity: 'warning',
      test(s, b) {
      const sTop = s?.js?.screen?.availTop;
      const bTop = b?.js?.screen?.availTop;
      const sLeft = s?.js?.screen?.availLeft;
      const bLeft = b?.js?.screen?.availLeft;
      if ((sTop !== undefined && bTop !== undefined && sTop !== bTop) ||
          (sLeft !== undefined && bLeft !== undefined && sLeft !== bLeft)) {
        return {
          id: 'screen_avail_top',
          category: 'screen',
          severity: 'warning',
          message: `screen.availTop/availLeft differ (availTop ${sTop}/${bTop}, availLeft ${sLeft}/${bLeft}). PerimeterX/Akamai read these.`,
          evidence: { subjectAvailTop: sTop, baselineAvailTop: bTop, subjectAvailLeft: sLeft, baselineAvailLeft: bLeft },
        };
      }
      return null;
    },
  },
  {
    id: 'screen_max_touch_points_desktop',
    name: 'maxTouchPoints > 0 on desktop OS',
    category: 'screen',
    severity: 'warning',
    test(s) {
      const os = osFromUA(s?.js?.navigator?.userAgent || '');
      const mtp = s?.js?.navigator?.maxTouchPoints;
      if (os && OS_DESKTOP.has(os) && typeof mtp === 'number' && mtp > 0) {
        return {
          id: 'screen_max_touch_points_desktop',
          category: 'screen',
          severity: 'warning',
          message: `maxTouchPoints=${mtp} on desktop ${os}. reCAPTCHA flags this.`,
          evidence: { maxTouchPoints: mtp, os },
        };
      }
      return null;
    },
  },
];
