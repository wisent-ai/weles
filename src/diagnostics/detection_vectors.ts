/**
 * Registry of known browser-automation detection vectors.
 *
 * Each rule compares a subject fingerprint (Weles) against a real-browser
 * baseline and returns a Finding when the subject exhibits a tell that
 * anti-bot systems (LinkedIn, reCAPTCHA Enterprise, PerimeterX, Akamai,
 * Cloudflare, BotD, etc.) are known to use.
 *
 * Rules are intentionally conservative: a Finding is evidence, not proof.
 * The analyzer scores and ranks them so operators see the most likely
 * detection signals first.
 */

export type FindingCategory =
  | 'navigator'
  | 'screen'
  | 'webgl'
  | 'canvas'
  | 'audio'
  | 'network'
  | 'behavior'
  | 'inconsistency';

export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface Finding {
  id: string;
  category: FindingCategory;
  severity: FindingSeverity;
  message: string;
  evidence: Record<string, unknown>;
}

export interface DetectionRule {
  id: string;
  name: string;
  category: FindingCategory;
  severity: FindingSeverity;
  test(subject: any, baseline: any): Finding | null;
}

const OS_DESKTOP = new Set(['windows', 'linux', 'macos']);

function osFromUA(ua: string): string | null {
  const u = ua.toLowerCase();
  if (u.includes('macintosh') || u.includes('mac os')) return 'macos';
  if (u.includes('windows nt')) return 'windows';
  if (u.includes('linux') || u.includes('x11')) return 'linux';
  return null;
}

function platformFromNav(platform: string): string | null {
  const p = String(platform || '').toLowerCase();
  if (p.includes('mac') || p.includes('darwin')) return 'macos';
  if (p.includes('win')) return 'windows';
  if (p.includes('linux')) return 'linux';
  return null;
}

function browserFromUA(ua: string): string | null {
  const u = ua.toLowerCase();
  if (u.includes('firefox') && !u.includes('seamonkey')) return 'firefox';
  if (u.includes('chrome') && !u.includes('edg') && !u.includes('opr')) return 'chrome';
  if (u.includes('safari') && !u.includes('chrome')) return 'safari';
  if (u.includes('edg')) return 'edge';
  return null;
}

const rules: DetectionRule[] = [
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

  // ---------------------------------------------------------------------------
  // Client Hints / userAgentData
  // ---------------------------------------------------------------------------
  {
    id: 'uad_brand_order',
    name: 'Sec-CH-UA brand order',
    category: 'navigator',
    severity: 'critical',
    test(s, b) {
      const sBrands = s?.js?.userAgentData?.brands;
      const bBrands = b?.js?.userAgentData?.brands;
      if (!Array.isArray(sBrands) || !Array.isArray(bBrands)) return null;
      const sOrder = sBrands.map((x: any) => x?.brand).join('|');
      const bOrder = bBrands.map((x: any) => x?.brand).join('|');
      if (sOrder && bOrder && sOrder !== bOrder) {
        return {
          id: 'uad_brand_order',
          category: 'navigator',
          severity: 'critical',
          message: `Sec-CH-UA brand order is wrong (${sOrder} vs ${bOrder}). Real Chrome uses a deterministic, version-keyed order.`,
          evidence: { subjectBrands: sBrands, baselineBrands: bBrands },
        };
      }
      return null;
    },
  },
  {
    id: 'uad_platform_arch',
    name: 'Client-hints platform/architecture inconsistency',
    category: 'inconsistency',
    severity: 'critical',
    test(s) {
      const uad = s?.js?.userAgentData;
      if (!uad) return null;
      const platform = String(uad.platform || '').toLowerCase();
      const arch = String(uad.architecture || '').toLowerCase();
      const renderer = String(s?.js?.webgl1?.params?.UNMASKED_RENDERER || '').toLowerCase();
      // Apple Silicon GPU must report arm arch on macOS.
      if (platform === 'macos' && renderer.includes('apple') && arch !== 'arm') {
        return {
          id: 'uad_platform_arch',
          category: 'inconsistency',
          severity: 'critical',
          message: `macOS + Apple GPU but client-hints architecture is '${arch}' (expected 'arm').`,
          evidence: { platform, architecture: arch, renderer: s?.js?.webgl?.unmaskedRenderer },
        };
      }
      // Windows/Linux personas should be x86.
      if ((platform === 'windows' || platform === 'linux') && arch !== 'x86') {
        return {
          id: 'uad_platform_arch',
          category: 'inconsistency',
          severity: 'warning',
          message: `${platform} client-hints architecture is '${arch}' (expected 'x86').`,
          evidence: { platform, architecture: arch },
        };
      }
      return null;
    },
  },

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

  // ---------------------------------------------------------------------------
  // Network
  // ---------------------------------------------------------------------------
  {
    id: 'tls_ja4_mismatch',
    name: 'TLS JA4 fingerprint mismatch',
    category: 'network',
    severity: 'critical',
    test(s, b) {
      const sj = s?.network?.ja4;
      const bj = b?.network?.ja4;
      if (sj && bj && sj !== bj) {
        return {
          id: 'tls_ja4_mismatch',
          category: 'network',
          severity: 'critical',
          message: `TLS JA4 fingerprint differs (${sj} vs ${bj}). LinkedIn can TLS-fingerprint clients.`,
          evidence: { subjectJa4: sj, baselineJa4: bj },
        };
      }
      return null;
    },
  },
  {
    id: 'tls_peetprint_mismatch',
    name: 'TLS peetprint mismatch',
    category: 'network',
    severity: 'critical',
    test(s, b) {
      const sp = s?.network?.peetprint_hash;
      const bp = b?.network?.peetprint_hash;
      if (sp && bp && sp !== bp) {
        return {
          id: 'tls_peetprint_mismatch',
          category: 'network',
          severity: 'critical',
          message: `TLS peetprint hash differs (${sp} vs ${bp}). Independent TLS signature from JA4.`,
          evidence: { subjectPeetprint: sp, baselinePeetprint: bp },
        };
      }
      return null;
    },
  },
  {
    id: 'h2_akamai_fingerprint_mismatch',
    name: 'HTTP/2 Akamai fingerprint mismatch',
    category: 'network',
    severity: 'critical',
    test(s, b) {
      const sh = s?.network?.akamaiH2;
      const bh = b?.network?.akamaiH2;
      if (sh && bh && sh !== bh) {
        return {
          id: 'h2_akamai_fingerprint_mismatch',
          category: 'network',
          severity: 'critical',
          message: `HTTP/2 Akamai fingerprint differs. Akamai Bot Manager uses SETTINGS + HPACK + pseudo-header order to score clients.`,
          evidence: { subjectAkamaiH2: sh, baselineAkamaiH2: bh },
        };
      }
      return null;
    },
  },
  {
    id: 'http_header_order_mismatch',
    name: 'HTTP request header order mismatch',
    category: 'network',
    severity: 'warning',
    test(s, b) {
      const sh = s?.network?.headers;
      const bh = b?.network?.headers;
      if (!sh || !bh) return null;
      const sKeys = Object.keys(sh).join('|');
      const bKeys = Object.keys(bh).join('|');
      if (sKeys !== bKeys) {
        return {
          id: 'http_header_order_mismatch',
          category: 'network',
          severity: 'warning',
          message: `Browser-sent header order differs from baseline. PerimeterX/DataDome/Akamai compare header order.`,
          evidence: { subjectHeaderKeys: Object.keys(sh), baselineHeaderKeys: Object.keys(bh) },
        };
      }
      return null;
    },
  },

  // ---------------------------------------------------------------------------
  // PerimeterX / privacy signals
  // ---------------------------------------------------------------------------
  {
    id: 'webrtc_local_ip_exposed',
    name: 'WebRTC local IP exposed',
    category: 'network',
    severity: 'warning',
    test(s) {
      const ips = s?.js?.webRTC?.localIPs;
      if (Array.isArray(ips) && ips.length > 0) {
        return {
          id: 'webrtc_local_ip_exposed',
          category: 'network',
          severity: 'warning',
          message: `WebRTC leaked local IP(s): ${ips.join(', ')}. PerimeterX checks WebRTC for proxy/datacenter mismatches.`,
          evidence: { localIPs: ips },
        };
      }
      return null;
    },
  },
  {
    id: 'webrtc_public_ip_mismatch',
    name: 'WebRTC public IP differs from egress IP',
    category: 'network',
    severity: 'critical',
    test(s) {
      const egressRaw = String(s?.network?.ip || '');
      const egressIP = egressRaw.split(':')[0];
      const rtcPublic = (s?.js?.webRTC?.localIPs || []).filter((ip: string) => !/^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|127\.|0\.0\.0\.0$|255\.)/.test(ip));
      if (!egressIP || rtcPublic.length === 0) return null;
      if (!rtcPublic.includes(egressIP)) {
        return {
          id: 'webrtc_public_ip_mismatch',
          category: 'network',
          severity: 'critical',
          message: `Egress IP (${egressIP}) not seen in WebRTC candidates (${rtcPublic.join(', ')}). Proxy leak / inconsistent routing.`,
          evidence: { egressIP, egressRaw, rtcPublicIPs: rtcPublic },
        };
      }
      return null;
    },
  },
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

export function getDetectionRules(): DetectionRule[] {
  return rules;
}
