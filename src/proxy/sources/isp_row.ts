// Synthetic Oxylabs ISP row. service_credentials has no ISP entry
// (verified via DB SELECT 2026-05-11), but the static-IP pool
// (isp.oxylabs.io:8001-8010) is the only proxy class allowed for LinkedIn
// per user rule. Build a row inline from env vars so resolveProxy() can
// return it for `isp oxylabs` filters.

export type IspRow = {
  display_name: string;
  proxy_host: string;
  proxy_port: string;
  api_key_env_var: string;
  balance_usd: number;
  metadata?: { country?: string };
};

export function maybeOxylabsIspRow(): IspRow | undefined {
  if (!process.env.OXYLABS_ISP_USERNAME || !process.env.OXYLABS_ISP_PASSWORD) return undefined;
  const host = process.env.OXYLABS_ISP_HOST || 'isp.oxylabs.io';
  const port = String(Number(process.env.OXYLABS_ISP_PORT || '8001'));
  return {
    display_name: 'Oxylabs ISP',
    proxy_host: host,
    proxy_port: port,
    api_key_env_var: 'OXYLABS_ISP_USERNAME',
    balance_usd: 0,
    metadata: { country: 'us' },
  };
}

// Decodo US Dedicated Static Residential ISP (purchased 2026-05-17).
// Each port is a FIXED exit IP — pin the first DECODO_ISP_PORTS entry so
// the location stays constant across runs. A stable static exit is the
// whole point: Discord/LinkedIn flag new-location/rotating-residential
// logins and disable the account; a consistent owned ISP IP does not.
// Creds in weles/.env (DECODO_ISP_USERNAME/PASSWORD/HOST/PORTS).
export function maybeDecodoIspRow(): IspRow | undefined {
  if (!process.env.DECODO_ISP_USERNAME || !process.env.DECODO_ISP_PASSWORD) return undefined;
  const host = process.env.DECODO_ISP_HOST || 'isp.decodo.com';
  const rawPorts = process.env.DECODO_ISP_PORTS || process.env.DECODO_ISP_PORT || '10001';
  const port = String(Number(rawPorts.split(',')[0].trim()));
  return {
    display_name: 'Decodo ISP',
    proxy_host: host,
    proxy_port: port,
    api_key_env_var: 'DECODO_ISP_USERNAME',
    balance_usd: 0,
    metadata: { country: 'us' },
  };
}
