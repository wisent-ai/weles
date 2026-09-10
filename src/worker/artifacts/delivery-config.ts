// What the artifact delivery service is configured with, read out of the
// environment by name and refused when a value is missing or unsafe.

const MIN_TTL_SECONDS = Number('30');
const MAX_TTL_SECONDS = Number('300');
const MIN_SECRET_BYTES = Number('32');
const MIN_PORT = Number('1');
const MAX_PORT = Number('65535');

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

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] ?? '').trim();
  if (!value) throw new Error(`missing required ${name}`);
  return value;
}

function parseSecureBaseUrl(raw: string, name: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${name} must not contain credentials, query parameters, or a fragment`);
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '::1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error(`${name} must use HTTPS, except for loopback HTTP`);
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new Error(`${name} must be an origin without a path`);
  }
  return parsed.origin;
}


export function loadArtifactDeliveryConfig(env: NodeJS.ProcessEnv = process.env): ArtifactDeliveryConfig {
  const host = requiredEnv(env, 'WELES_ARTIFACT_DELIVERY_HOST');
  if (host.trim() !== host || host.includes('/') || host.includes('\\') || host.includes('\0')) {
    throw new Error('WELES_ARTIFACT_DELIVERY_HOST is invalid');
  }
  const port = Number(requiredEnv(env, 'WELES_ARTIFACT_DELIVERY_PORT'));
  if (!Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error('WELES_ARTIFACT_DELIVERY_PORT must be a valid TCP port');
  }
  const ttlSeconds = Number(env.WELES_ARTIFACT_URL_TTL_SECONDS ?? String(MAX_TTL_SECONDS));
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`WELES_ARTIFACT_URL_TTL_SECONDS must be between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}`);
  }

  const clientToken = requiredEnv(env, 'WELES_ARTIFACT_DELIVERY_TOKEN');
  const signingSecret = requiredEnv(env, 'WELES_ARTIFACT_SIGNING_SECRET');
  const stadoApiToken = requiredEnv(env, 'WELES_STADO_OBJECT_API_TOKEN');
  const subscriptionsToken = requiredEnv(env, 'OKO_WELES_SUBSCRIPTIONS_TOKEN');
  if (Buffer.byteLength(clientToken) < MIN_SECRET_BYTES) {
    throw new Error('WELES_ARTIFACT_DELIVERY_TOKEN must contain at least 32 bytes');
  }
  if (Buffer.byteLength(signingSecret) < MIN_SECRET_BYTES) {
    throw new Error('WELES_ARTIFACT_SIGNING_SECRET must contain at least 32 bytes');
  }
  if (Buffer.byteLength(subscriptionsToken) < MIN_SECRET_BYTES) {
    throw new Error('OKO_WELES_SUBSCRIPTIONS_TOKEN must contain at least 32 bytes');
  }
  const serviceCredentials = [
    clientToken,
    signingSecret,
    stadoApiToken,
    subscriptionsToken,
  ];
  if (new Set(serviceCredentials).size !== serviceCredentials.length) {
    throw new Error('Weles artifact, subscription, and Stado credentials must be distinct');
  }
  for (const siblingName of ['WELES_STADO_MODEL_ROUTER_TOKEN', 'WELES_STADO_MEDIA_ROUTER_TOKEN']) {
    const sibling = String(env[siblingName] ?? '').trim();
    if (sibling && serviceCredentials.includes(sibling)) {
      throw new Error(`${siblingName} must be distinct from Weles service credentials`);
    }
  }

  const allowedOriginRaw = String(env.WELES_ARTIFACT_ALLOWED_ORIGIN ?? '').trim();
  return {
    host,
    port,
    publicBaseUrl: parseSecureBaseUrl(requiredEnv(env, 'WELES_ARTIFACT_DELIVERY_URL'), 'WELES_ARTIFACT_DELIVERY_URL'),
    clientToken,
    signingSecret,
    ttlSeconds,
    stadoApiUrl: parseSecureBaseUrl(requiredEnv(env, 'STADO_API_URL'), 'STADO_API_URL'),
    stadoApiToken,
    subscriptionsToken,
    allowedOrigin: allowedOriginRaw ? parseSecureBaseUrl(allowedOriginRaw, 'WELES_ARTIFACT_ALLOWED_ORIGIN') : null,
  };
}

