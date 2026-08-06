import { readOptionalWelesServiceSecret, type WelesServiceSecret } from '../../secrets/scoped-service.js';

// Exact scoped ISP rows. Endpoints and credentials come from one dedicated
// Skarbiec item/client per provider; absent grants omit the provider.

export type IspRow = {
  display_name: string;
  proxy_host: string;
  proxy_port: string;
  secret_service: WelesServiceSecret;
  balance_usd: number;
  metadata?: { country?: string };
};

export function maybeOxylabsIspRow(): IspRow | undefined {
  const host = readOptionalWelesServiceSecret('oxylabsIsp', 'host');
  const port = readOptionalWelesServiceSecret('oxylabsIsp', 'ports')?.split(',').map((value) => value.trim()).find(Boolean);
  if (!host || !port) return undefined;
  return {
    display_name: 'Oxylabs ISP',
    proxy_host: host,
    proxy_port: port,
    secret_service: 'oxylabsIsp',
    balance_usd: Number('0'),
    metadata: { country: 'us' },
  };
}

export function maybeOxylabsDedicatedIspRow(): IspRow | undefined {
  const host = readOptionalWelesServiceSecret('oxylabsDedicatedIsp', 'host');
  const port = readOptionalWelesServiceSecret('oxylabsDedicatedIsp', 'ports')?.split(',').map((value) => value.trim()).find(Boolean);
  if (!host || !port) return undefined;
  return {
    display_name: 'Oxylabs Dedicated ISP',
    proxy_host: host,
    proxy_port: port,
    secret_service: 'oxylabsDedicatedIsp',
    balance_usd: Number('0'),
    metadata: { country: 'us' },
  };
}

// Decodo dedicated static ISP ports are all fixed exits in one exact item.
export function maybeDecodoIspRows(): IspRow[] {
  const host = readOptionalWelesServiceSecret('decodoIsp', 'host');
  const rawPorts = readOptionalWelesServiceSecret('decodoIsp', 'ports');
  if (!host || !rawPorts) return [];
  const ports = [...new Set(rawPorts.split(',').map((port) => String(Number(port.trim()))).filter((port) => port !== 'NaN'))];
  return ports.map((port) => ({
    display_name: ports.length === Number('1') ? 'Decodo ISP' : `Decodo ISP ${port}`,
    proxy_host: host,
    proxy_port: port,
    secret_service: 'decodoIsp',
    balance_usd: Number('0'),
    metadata: { country: 'us' },
  }));
}

export function maybeDecodoIspRow(): IspRow | undefined {
  return maybeDecodoIspRows()[0];
}
