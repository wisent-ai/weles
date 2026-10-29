// Where a candidate exit is and what network it belongs to, read from the
// exit address before an exit is bound: its country against the one the run
// asked for, and the provider-, hosting- and mobile-network classification
// recorded with the run. Split out of policy.ts, which keeps the provider
// rules.

// Country-verify a proxy exit IP via ip-api.com.
// Providers (Oxylabs in particular) sometimes route residential traffic
// through a non-US exit when their US pool is exhausted. TikTok routes
// geo-mismatched sessions to the ttp2 security cluster which fails the
// SubtleCrypto fingerprint step and returns error_code 1340 at
// register_verify_login. In the diff harness against a chrome reference, a
// success run has subtleCrypto.count=6 + mssdk.tiktokw.us and a 1340 run
// has subtleCrypto.count=0 + mssdk-ttp2.tiktokw.us; the differentiator is
// geo: success from a US exit, failure from a non-US exit.
export type GeoCheckResult = 'match' | 'mismatch' | 'unknown';
export async function verifyExitCountry(
  exitIp: string,
  expectedCc: string,
): Promise<{ result: GeoCheckResult; exitCc?: string }> {
  if (!exitIp || !expectedCc) return { result: 'unknown' };
  try {
    const r = await fetch(
      `http://ip-api.com/json/${exitIp}?fields=countryCode`,
    );
    const j = (await r.json()) as { countryCode?: string };
    const exitCc = (j?.countryCode || '').toLowerCase();
    if (!exitCc) return { result: 'unknown' };
    if (exitCc === expectedCc.toLowerCase()) return { result: 'match', exitCc };
    return { result: 'mismatch', exitCc };
  } catch {
    return { result: 'unknown' };
  }
}

// Read the provider's proxy and hosting classification before binding an exit.
// A failed measurement remains unknown rather than proving a clean address.
export type ReputationResult =
  | 'clean'
  | 'proxy'
  | 'hosting'
  | 'mobile'
  | 'unknown';
export interface ExitReputation {
  result: ReputationResult;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  lat?: number;
  lon?: number;
  timezone?: string;
  isp?: string;
  org?: string;
  as?: string;
  asname?: string;
  reverse?: string;
  proxy?: boolean;
  hosting?: boolean;
  mobile?: boolean;
}
// Full exit-IP enrichment via ip-api.com (free tier). Returns the derived
// reputation `result` (proxy/hosting/mobile flags collapsed) AND the raw
// geo/ASN/ISP/reverse-DNS fields so the exact exit identity is recorded.
// `result` is what callers gate on; the rest is provenance stored per run.
export async function verifyExitReputation(
  exitIp: string,
): Promise<ExitReputation> {
  if (!exitIp) return { result: 'unknown' };
  try {
    const fields =
      'status,country,countryCode,regionName,city,lat,lon,timezone,isp,org,as,asname,reverse,mobile,proxy,hosting';
    const r = await fetch(`http://ip-api.com/json/${exitIp}?fields=${fields}`);
    const j = (await r.json()) as Record<string, any>;
    if (j?.status !== 'success') return { result: 'unknown' };
    const result: ReputationResult =
      j.proxy === true
        ? 'proxy'
        : j.hosting === true
          ? 'hosting'
          : j.mobile === true
            ? 'mobile'
            : 'clean';
    return {
      result,
      country: j.country,
      countryCode: j.countryCode,
      region: j.regionName,
      city: j.city,
      lat: j.lat,
      lon: j.lon,
      timezone: j.timezone,
      isp: j.isp,
      org: j.org,
      as: j.as,
      asname: j.asname,
      reverse: j.reverse,
      proxy: j.proxy,
      hosting: j.hosting,
      mobile: j.mobile,
    };
  } catch {
    return { result: 'unknown' };
  }
}
