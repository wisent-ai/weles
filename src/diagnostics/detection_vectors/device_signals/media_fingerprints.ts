/**
 * Do the media subsystems rasterise and enumerate like a real machine?
 *
 * Canvas and OfflineAudioContext are stable hashes of a host's 2D and DSP
 * pipelines, and enumerateDevices is the roster of peripherals attached to
 * that host. All three answer one question — "is there a real machine with
 * real media hardware under this browser?" — and all three break the same
 * way: a container has no sound card, no camera, and a rasteriser that is
 * subtly not the one the baseline used.
 *
 * They are grouped away from WebGL because the failure they detect is an
 * absent or emulated media stack rather than an absent or emulated GPU, and
 * the evidence an operator needs to act on is different in kind: a hash to
 * diff versus a device roster to populate.
 */

import type { DetectionRule } from '../finding.js';

export const mediaFingerprintRules: DetectionRule[] = [
  // ---------------------------------------------------------------------------
  // Canvas / Audio
  // ---------------------------------------------------------------------------
  {
    id: 'canvas_hash_mismatch',
    name: 'Canvas 2D hash mismatch',
    category: 'canvas',
    severity: 'warning',
    test(s, b) {
      const sh = s?.js?.canvas?.toDataURLHead;
      const bh = b?.js?.canvas?.toDataURLHead;
      if (sh && bh && sh !== bh) {
        return {
          id: 'canvas_hash_mismatch',
          category: 'canvas',
          severity: 'warning',
          message: `Canvas toDataURL header differs. TikTok mssdk and others compare canvas hashes.`,
          evidence: { subjectHead: sh, baselineHead: bh },
        };
      }
      return null;
    },
  },
  {
    id: 'audio_hash_mismatch',
    name: 'OfflineAudioContext hash mismatch',
    category: 'audio',
    severity: 'info',
    test(s, b) {
      const sh = s?.js?.audio?.oacHash;
      const bh = b?.js?.audio?.oacHash;
      if (sh && bh && sh !== bh) {
        return {
          id: 'audio_hash_mismatch',
          category: 'audio',
          severity: 'info',
          message: `OfflineAudioContext hash differs (${sh} vs ${bh}).`,
          evidence: { subjectHash: sh, baselineHash: bh },
        };
      }
      return null;
    },
  },
  {
    id: 'audio_context_missing',
    name: 'AudioContext unavailable or generic',
    category: 'audio',
    severity: 'warning',
    test(s, b) {
      const sa = s?.js?.audio;
      const ba = b?.js?.audio;
      if (ba && !sa) {
        return {
          id: 'audio_context_missing',
          category: 'audio',
          severity: 'warning',
          message: 'AudioContext is missing or failed on subject while baseline has it. Headless/no-audio setups are flagged.',
          evidence: { subjectAudio: sa, baselineAudio: ba },
        };
      }
      return null;
    },
  },
  {
    id: 'media_devices_empty',
    name: 'mediaDevices.enumerateDevices empty',
    category: 'navigator',
    severity: 'warning',
    test(s, b) {
      const sDevs = s?.js?.mediaDevices;
      const bDevs = b?.js?.mediaDevices;
      const sLen = Array.isArray(sDevs) ? sDevs.length : null;
      const bLen = Array.isArray(bDevs) ? bDevs.length : null;
      if (sLen === 0 && (bLen ?? 0) > 0) {
        return {
          id: 'media_devices_empty',
          category: 'navigator',
          severity: 'warning',
          message: `enumerateDevices returned no devices (${bLen} expected). Real Chrome exposes audio/video devices even without permission.`,
          evidence: { subjectDevices: sDevs, baselineDevices: bDevs },
        };
      }
      return null;
    },
  },
];
