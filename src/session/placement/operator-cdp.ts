import { loopbackHost } from '../../utils/runtime/service-origin.js';
import {
  optionalSetting,
  requiredSetting,
  secretSetting,
} from '../../utils/runtime/settings.js';

export interface OperatorCdpConfig {
  endpoint: string;
  token: string;
}

const TOKEN_SIBLINGS = [
  'WELES_STADO_OBJECT_API_TOKEN',
  'WELES_STADO_MODEL_ROUTER_TOKEN',
  'WELES_ARTIFACT_DELIVERY_TOKEN',
  'CONTENT_DIAGNOSTICS_API_TOKEN',
  'TRADING_TOOLS_INGEST_TOKEN',
] as const;

export function loadOperatorCdpConfig(
  env: NodeJS.ProcessEnv = process.env,
): OperatorCdpConfig {
  const rawEndpoint = requiredSetting(env, 'WELES_OPERATOR_CDP_URL');
  const token = secretSetting(env, 'WELES_OPERATOR_CDP_TOKEN');
  for (const siblingName of TOKEN_SIBLINGS) {
    if (optionalSetting(env, siblingName) === token) {
      throw new Error(
        `WELES_OPERATOR_CDP_TOKEN must be distinct from ${siblingName}`,
      );
    }
  }

  if (!URL.canParse(rawEndpoint)) {
    throw new Error(
      `WELES_OPERATOR_CDP_URL is not a URL: ${JSON.stringify(rawEndpoint)}`,
    );
  }
  const endpoint = new URL(rawEndpoint);
  const tls = endpoint.protocol === 'https:' || endpoint.protocol === 'wss:';
  const authenticatedLoopback =
    loopbackHost(endpoint.hostname) &&
    (endpoint.protocol === 'http:' || endpoint.protocol === 'ws:');
  if (!tls && !authenticatedLoopback) {
    throw new Error(
      `WELES_OPERATOR_CDP_URL must use TLS, except for authenticated loopback (localhost or an address of one of this machine's internal network interfaces): ${endpoint.protocol}//${endpoint.hostname}`,
    );
  }
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error(
      'WELES_OPERATOR_CDP_URL must not contain credentials, query, or fragment',
    );
  }
  return { endpoint: endpoint.toString(), token };
}
