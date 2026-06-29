// Synthetic Oxylabs ISP rows. service_credentials has no ISP entry
// (verified via DB SELECT 2026-05-11), so we build rows inline from env vars.
// We expose both the shared static-IP pool (isp.oxylabs.io) and dedicated
// static ISP ports (disp.oxylabs.io). resolveProxy() can return them for
// `isp oxylabs` filters.

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

export function maybeOxylabsDedicatedIspRow(): IspRow | undefined {
  if (!process.env.OXYLABS_DEDICATED_ISP_USERNAME || !process.env.OXYLABS_DEDICATED_ISP_PASSWORD) return undefined;
  const host = process.env.OXYLABS_DEDICATED_ISP_HOST || 'disp.oxylabs.io';
  const port = String(Number(process.env.OXYLABS_DEDICATED_ISP_PORT || '8001'));
  return {
    display_name: 'Oxylabs Dedicated ISP',
    proxy_host: host,
    proxy_port: port,
    api_key_env_var: 'OXYLABS_DEDICATED_ISP_USERNAME',
    balance_usd: 0,
    metadata: { country: 'us' },
  };
}

// Decodo US Dedicated Static Residential ISP (purchased 2026-05-17).
// Each port is a FIXED exit IP. Expose every DECODO_ISP_PORTS entry as its own
// provider row so signup runners can reject one challenged exit and continue
// auditing the remaining owned static ports.
// Creds in weles/.env (DECODO_ISP_USERNAME/PASSWORD/HOST/PORTS).
export function maybeDecodoIspRows(): IspRow[] {
  if (!process.env.DECODO_ISP_USERNAME || !process.env.DECODO_ISP_PASSWORD) return [];
  const host = process.env.DECODO_ISP_HOST || 'isp.decodo.com';
  const rawPorts = process.env.DECODO_ISP_PORTS || process.env.DECODO_ISP_PORT || '10001';
  const ports = [...new Set(rawPorts.split(',').map((p) => String(Number(p.trim()))).filter((p) => p !== 'NaN'))];
  return ports.map((port) => ({
    display_name: ports.length === 1 ? 'Decodo ISP' : `Decodo ISP ${port}`,
    proxy_host: host,
    proxy_port: port,
    api_key_env_var: 'DECODO_ISP_USERNAME',
    balance_usd: 0,
    metadata: { country: 'us' },
  }));
}

export function maybeDecodoIspRow(): IspRow | undefined {
  return maybeDecodoIspRows()[0];
}
