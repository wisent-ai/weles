/**
 * Do the persona's own signals agree with each other, baseline or not?
 *
 * Every other family asks whether the subject matches a real-browser capture.
 * These two ask something a detector can ask with no reference at all: an
 * Apple GPU under a Windows User-Agent, or a `navigator.platform` that names
 * a different operating system than the User-Agent does, is a contradiction
 * on its face. A site needs no baseline and no history to reject it.
 *
 * That independence from the baseline is the reason they are separated out.
 * They are also the findings an operator must fix first — an internally
 * inconsistent persona cannot be rescued by matching any single value more
 * closely.
 */

import type { DetectionRule } from '../finding.js';
import { osFromUA, platformFromNav } from '../persona_identity.js';

export const personaConsistencyRules: DetectionRule[] = [
  // ---------------------------------------------------------------------------
  // Cross-signal consistency
  // ---------------------------------------------------------------------------
  {
    id: 'ua_webgl_os_inconsistency',
    name: 'User-Agent OS vs WebGL GPU inconsistency',
    category: 'inconsistency',
    severity: 'critical',
    test(s) {
      const ua = String(s?.js?.navigator?.userAgent || '');
      const renderer = String(s?.js?.webgl1?.params?.UNMASKED_RENDERER || '').toLowerCase();
      const os = osFromUA(ua);
      if (!os) return null;
      // Apple GPU on non-macOS UA.
      if (renderer.includes('apple') && os !== 'macos') {
        return {
          id: 'ua_webgl_os_inconsistency',
          category: 'inconsistency',
          severity: 'critical',
          message: `UA says ${os} but WebGL renderer is Apple GPU (${renderer}).`,
          evidence: { os, renderer, userAgent: ua },
        };
      }
      // Intel UHD on macOS.
      if (renderer.includes('intel') && os === 'macos' && !renderer.includes('apple')) {
        return {
          id: 'ua_webgl_os_inconsistency',
          category: 'inconsistency',
          severity: 'warning',
          message: `UA says macOS but WebGL renderer is Intel (${renderer}).`,
          evidence: { os, renderer, userAgent: ua },
        };
      }
      return null;
    },
  },
  {
    id: 'platform_ua_inconsistency',
    name: 'navigator.platform vs User-Agent OS inconsistency',
    category: 'inconsistency',
    severity: 'critical',
    test(s) {
      const ua = String(s?.js?.navigator?.userAgent || '');
      const platform = String(s?.js?.navigator?.platform || '');
      const osUA = osFromUA(ua);
      const osPlatform = platformFromNav(platform);
      if (osUA && osPlatform && osUA !== osPlatform) {
        return {
          id: 'platform_ua_inconsistency',
          category: 'inconsistency',
          severity: 'critical',
          message: `User-Agent OS (${osUA}) does not match navigator.platform (${platform} -> ${osPlatform}).`,
          evidence: { userAgent: ua, platform, osUA, osPlatform },
        };
      }
      return null;
    },
  },
];
