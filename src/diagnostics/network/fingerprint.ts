// The network-side fingerprint a session's browser presents: the TLS and
// HTTP/2 shape a fingerprinting echo service reports for the connection.

export const NETWORK_FP_URL = 'https://tls.peet.ws/api/all';

export interface NetworkFingerprint {
  ja3?: string;
  ja3_hash?: string;
  ja4?: string;
  peetprint?: string;
  peetprint_hash?: string;
  ciphers?: string[];
  extensions?: string[];
  supportedVersions?: string[];
  signatureAlgorithms?: string[];
  groups?: string[];
  akamaiH2?: string;
  h2Frames?: unknown[];
  ip?: string;
  userAgent?: string;
  headers?: Record<string, string>;
}

/**
 * The fingerprint in the echo service's answer `raw`; an answer that is not
 * JSON is kept whole beside the parser's error, so the report shows what
 * the service sent.
 */
export function parseNetworkFingerprint(
  raw: string,
): NetworkFingerprint | { _err: string; raw: string } {
  let j;
  try {
    j = JSON.parse(raw);
  } catch (error) {
    return { _err: String(error), raw };
  }
  if (j === null || typeof j !== 'object')
    return {
      _err: 'the echo service answered JSON that is not an object',
      raw,
    };
  return {
    ja3: j.tls?.ja3,
    ja3_hash: j.tls?.ja3_hash,
    ja4: j.tls?.ja4,
    peetprint: j.tls?.peetprint,
    peetprint_hash: j.tls?.peetprint_hash,
    ciphers: j.tls?.ciphers,
    extensions: j.tls?.extensions?.map((e: any) => e.name ?? e),
    supportedVersions: j.tls?.supported_versions,
    signatureAlgorithms: j.tls?.signature_algorithms,
    groups: j.tls?.supported_groups ?? j.tls?.elliptic_curves,
    akamaiH2: j.http2?.akamai_fingerprint,
    h2Frames: j.http2?.sent_frames,
    ip: j.ip,
    userAgent: j.user_agent,
    headers: j.headers,
  };
}
