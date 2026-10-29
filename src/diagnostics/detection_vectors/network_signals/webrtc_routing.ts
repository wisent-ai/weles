/**
 * Does WebRTC tell the same story about routing as the egress connection?
 *
 * WebRTC gathers ICE candidates from the host's own interfaces, which makes
 * it the one API that can see around a proxy. Two things can go wrong and
 * they are different failures: leaking a local (non-public) address at all,
 * and publishing a public candidate that is not the address the site actually
 * saw the request arrive from.
 *
 * Whether an address is public is IANA's reading (proxy/quality/
 * special-addresses.ts), the same one the browser-evidence policy uses, for
 * IPv4 and IPv6 alike, so a unique-local or link-local IPv6 candidate is a
 * local leak, and an IPv6 egress is compared whole rather than cut at its
 * first colon.
 *
 * These are filed with the network signals — not with the browser surface —
 * because the remedy is a proxy or interface change, and they are held apart
 * from the transport fingerprints because they compare the subject against
 * itself rather than against a baseline capture.
 */

import { isIP } from 'node:net';
import type { DetectionRule } from '../finding.js';
import { specialBlockOf } from '../../../proxy/quality/special-addresses.js';

/**
 * Whether `address` is not public: it lies in an IANA special-purpose block
 * not declared globally reachable. Unread registries are not a verdict: the
 * error reaches the analyzer, which records that this rule could not judge.
 */
function isNonPublic(address: string): boolean {
  const block = specialBlockOf(address);
  return block !== null && !block.globallyReachable;
}

/** The candidate addresses the probe recorded, as text. */
function candidateAddresses(
  subject: { js?: { webRTC?: { localIPs?: unknown } } } | undefined,
): string[] {
  const ips = subject?.js?.webRTC?.localIPs;
  if (!Array.isArray(ips)) return [];
  return ips.filter((ip: unknown): ip is string => typeof ip === 'string');
}

/**
 * The address part of the recorded egress: a bare address, an IPv4
 * `address:port`, or a bracketed `[IPv6]:port`; null when it is none of these.
 */
function egressAddress(recorded: unknown): string | null {
  if (typeof recorded !== 'string') return null;
  const text = recorded.trim();
  if (isIP(text)) return text;
  const bracketed = text.match(/^\[(?<address>[^\]]+)\](?::\d+)?$/);
  if (bracketed?.groups && isIP(bracketed.groups.address))
    return bracketed.groups.address;
  const withPort = text.match(/^(?<address>[^:]+):\d+$/);
  if (withPort?.groups && isIP(withPort.groups.address))
    return withPort.groups.address;
  return null;
}

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
      const local = candidateAddresses(s).filter(
        (ip) => isIP(ip) && isNonPublic(ip),
      );
      if (!local.length) return null;
      return {
        id: 'webrtc_local_ip_exposed',
        category: 'network',
        severity: 'warning',
        message: `WebRTC leaked local IP(s): ${local.join(', ')}. PerimeterX checks WebRTC for proxy/datacenter mismatches.`,
        evidence: { localIPs: local },
      };
    },
  },
  {
    id: 'webrtc_public_ip_mismatch',
    name: 'WebRTC public IP differs from egress IP',
    category: 'network',
    severity: 'critical',
    test(s) {
      const egressRaw = s?.network?.ip;
      const egressIP = egressAddress(egressRaw);
      const rtcPublic = candidateAddresses(s).filter(
        (ip) => isIP(ip) && !isNonPublic(ip),
      );
      if (!egressIP || !rtcPublic.length) return null;
      if (rtcPublic.includes(egressIP)) return null;
      return {
        id: 'webrtc_public_ip_mismatch',
        category: 'network',
        severity: 'critical',
        message: `Egress IP (${egressIP}) not seen in WebRTC candidates (${rtcPublic.join(', ')}). Proxy leak / inconsistent routing.`,
        evidence: { egressIP, egressRaw, rtcPublicIPs: rtcPublic },
      };
    },
  },
];
