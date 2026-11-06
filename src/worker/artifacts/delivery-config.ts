// What the artifact delivery service is configured with, read out of the
// environment by name and refused when a value is missing or unsafe.
import { serviceOrigin } from '../../utils/runtime/service-origin.js';
import {
  optionalSetting,
  positiveWholeSetting,
  requiredSetting,
  secretSetting,
  tcpPortSetting,
} from '../../utils/runtime/settings.js';

export type ArtifactDeliveryConfig = {
  host: string;
  port: number;
  publicBaseUrl: string;
  clientToken: string;
  signingSecret: string;
  ttlSeconds: number;
  stadoApiUrl: string;
  stadoApiToken: string;
  allowedOrigin: string | null;
  subscriptionsToken: string;
};

/** A credential another Weles service holds, which none of these may repeat. */
const SIBLING_CREDENTIAL = 'WELES_STADO_MODEL_ROUTER_TOKEN';

export function loadArtifactDeliveryConfig(
  env: NodeJS.ProcessEnv = process.env,
): ArtifactDeliveryConfig {
  const host = requiredSetting(env, 'WELES_ARTIFACT_DELIVERY_HOST');
  if (host.includes('/') || host.includes('\\') || host.includes('\0')) {
    throw new Error(
      `WELES_ARTIFACT_DELIVERY_HOST is ${JSON.stringify(host)}, which holds a path separator or a NUL and names no host`,
    );
  }
  const port = tcpPortSetting(env, 'WELES_ARTIFACT_DELIVERY_PORT');
  const ttlSeconds = positiveWholeSetting(
    env,
    'WELES_ARTIFACT_URL_TTL_SECONDS',
    'seconds',
  );

  const clientToken = secretSetting(env, 'WELES_ARTIFACT_DELIVERY_TOKEN');
  const signingSecret = secretSetting(env, 'WELES_ARTIFACT_SIGNING_SECRET');
  const stadoApiToken = requiredSetting(env, 'WELES_STADO_OBJECT_API_TOKEN');
  const subscriptionsToken = secretSetting(
    env,
    'OKO_WELES_SUBSCRIPTIONS_TOKEN',
  );
  const serviceCredentials = [
    clientToken,
    signingSecret,
    stadoApiToken,
    subscriptionsToken,
  ];
  if (new Set(serviceCredentials).size !== serviceCredentials.length) {
    throw new Error(
      'Weles artifact, subscription, and Stado credentials must be distinct',
    );
  }
  const sibling = optionalSetting(env, SIBLING_CREDENTIAL);
  if (sibling !== null && serviceCredentials.includes(sibling)) {
    throw new Error(
      `${SIBLING_CREDENTIAL} must be distinct from Weles service credentials`,
    );
  }

  const allowedOrigin = optionalSetting(env, 'WELES_ARTIFACT_ALLOWED_ORIGIN');
  return {
    host,
    port,
    publicBaseUrl: serviceOrigin(
      'WELES_ARTIFACT_DELIVERY_URL',
      env.WELES_ARTIFACT_DELIVERY_URL,
    ),
    clientToken,
    signingSecret,
    ttlSeconds,
    stadoApiUrl: serviceOrigin('STADO_API_URL', env.STADO_API_URL),
    stadoApiToken,
    subscriptionsToken,
    allowedOrigin:
      allowedOrigin === null
        ? null
        : serviceOrigin('WELES_ARTIFACT_ALLOWED_ORIGIN', allowedOrigin),
  };
}
