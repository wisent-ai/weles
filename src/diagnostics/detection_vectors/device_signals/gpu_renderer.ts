/**
 * Is there real graphics hardware behind WebGL, and is it the same hardware?
 *
 * The unmasked vendor/renderer strings and the shader precision table come
 * straight from the GPU driver, so they are the hardest part of a persona to
 * fake and the first thing a serious detector reads. SwiftShader is the
 * special case that needs no baseline at all: a software rasteriser names
 * itself, and naming itself is the whole finding.
 *
 * This family answers a hardware question and moves when GPUs, drivers or
 * Chromium's ANGLE backend move. That is a different cadence from the panel
 * numbers next door in screen geometry, which follow the display and the
 * window manager.
 */

import type { DetectionRule } from '../finding.js';

export const gpuRendererRules: DetectionRule[] = [
  // ---------------------------------------------------------------------------
  // WebGL
  // ---------------------------------------------------------------------------
  {
    id: 'webgl_renderer_mismatch',
    name: 'WebGL renderer mismatch',
    category: 'webgl',
    severity: 'critical',
    test(s, b) {
      const sr = s?.js?.webgl1?.params?.UNMASKED_RENDERER;
      const br = b?.js?.webgl1?.params?.UNMASKED_RENDERER;
      if (sr && br && sr !== br) {
        return {
          id: 'webgl_renderer_mismatch',
          category: 'webgl',
          severity: 'critical',
          message: `WebGL renderer differs: "${sr}" vs "${br}".`,
          evidence: { subjectRenderer: sr, baselineRenderer: br },
        };
      }
      return null;
    },
  },
  {
    id: 'webgl_vendor_mismatch',
    name: 'WebGL vendor mismatch',
    category: 'webgl',
    severity: 'warning',
    test(s, b) {
      const sv = s?.js?.webgl1?.params?.UNMASKED_VENDOR;
      const bv = b?.js?.webgl1?.params?.UNMASKED_VENDOR;
      if (sv && bv && sv !== bv) {
        return {
          id: 'webgl_vendor_mismatch',
          category: 'webgl',
          severity: 'warning',
          message: `WebGL vendor differs: "${sv}" vs "${bv}".`,
          evidence: { subjectVendor: sv, baselineVendor: bv },
        };
      }
      return null;
    },
  },
  {
    id: 'webgl_precision_mismatch',
    name: 'WebGL shader precision mismatch',
    category: 'webgl',
    severity: 'warning',
    test(s, b) {
      const sp = s?.js?.webgl1?.precision;
      const bp = b?.js?.webgl1?.precision;
      if (!sp || !bp) return null;
      const keys = new Set([...Object.keys(sp), ...Object.keys(bp)]);
      for (const k of keys) {
        if (JSON.stringify(sp[k]) !== JSON.stringify(bp[k])) {
          return {
            id: 'webgl_precision_mismatch',
            category: 'webgl',
            severity: 'warning',
            message: `WebGL shader precision ${k} differs.`,
            evidence: { key: k, subject: sp[k], baseline: bp[k] },
          };
        }
      }
      return null;
    },
  },
  {
    id: 'webgl_swiftshader',
    name: 'WebGL SwiftShader software renderer',
    category: 'webgl',
    severity: 'critical',
    test(s) {
      const r = String(s?.js?.webgl1?.params?.UNMASKED_RENDERER || '').toLowerCase();
      if (r.includes('swiftshader')) {
        return {
          id: 'webgl_swiftshader',
          category: 'webgl',
          severity: 'critical',
          message: `WebGL renderer is SwiftShader (${s.js.webgl1.params.UNMASKED_RENDERER}) — headless/software rendering signature flagged by PerimeterX/Cloudflare.`,
          evidence: { renderer: s.js.webgl1.params.UNMASKED_RENDERER },
        };
      }
      return null;
    },
  },
];
