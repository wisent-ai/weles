/**
 * Does WebRTC tell the same story about routing as the egress connection?
 *
 * WebRTC gathers ICE candidates from the host's own interfaces, which makes
 * it the one API that can see around a proxy. Two things can go wrong and
 * they are different failures: leaking an RFC1918 address at all, and
 * publishing a public candidate that is not the address the site actually
 * saw the request arrive from.
 *
 * These are filed with the network signals — not with the browser surface —
 * because the remedy is a proxy or interface change, and they are held apart
 * from the transport fingerprints because they compare the subject against
 * itself rather than against a baseline capture.
 */

import type { DetectionRule } from '../finding.js';

export const webrtcRoutingRules: DetectionRule[] = [
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
];
