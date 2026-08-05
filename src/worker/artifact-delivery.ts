import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const SIGN_PATH = '/v1/artifacts/sign';
const OBJECT_PATH = '/v1/artifacts/object';
const SUBSCRIPTIONS_PATH = '/v1/subscriptions';
const WELES_ARTIFACT_PREFIX = 'stado://weles/recordings/';
const ARTIFACT_KINDS = ['screenshots', 'videos', 'dom', 'logs'] as const;
const MIN_TTL_SECONDS = Number('30');
const MAX_TTL_SECONDS = Number('300');
const MILLIS_PER_SECOND = Number('1000');
const MAX_REQUEST_BYTES = Number('1048576');
const MAX_ARTIFACT_COUNT = Number('10000');
const MAX_LOCATOR_LENGTH = Number('4096');
const MIN_SECRET_BYTES = Number('32');
const MAX_SUBSCRIPTION_COUNT = Number('1000');
const MAX_SUBSCRIPTION_TEXT_LENGTH = Number('512');
const HMAC_HEX_LENGTH = Number('64');
const MIN_PORT = Number('1');
const MAX_PORT = Number('65535');

export type ArtifactKind = typeof ARTIFACT_KINDS[number];

export type ArtifactLocatorSet = {
  screenshots: string[];
  videos: string[];
  dom: string[];
  logs: string[];
};

export type SignedArtifactResponse = {
  artifacts: ArtifactLocatorSet;
  expires_at: string;
};

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
  databaseUrl: string;
  databaseToken: string;
};

class RequestFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

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
  const databaseToken = requiredEnv(env, 'WELES_DATABASE_TOKEN');
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
    databaseToken,
  ];
  if (new Set(serviceCredentials).size !== serviceCredentials.length) {
    throw new Error('Weles artifact, subscription, Stado, and database credentials must be distinct');
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
    databaseUrl: parseSecureBaseUrl(requiredEnv(env, 'WELES_DATABASE_URL'), 'WELES_DATABASE_URL'),
    databaseToken,
    allowedOrigin: allowedOriginRaw ? parseSecureBaseUrl(allowedOriginRaw, 'WELES_ARTIFACT_ALLOWED_ORIGIN') : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalWelesArtifactUri(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim() || value.length > MAX_LOCATOR_LENGTH) {
    throw new RequestFailure(Number('400'), 'artifact locator must be a bounded canonical string');
  }
  if (!value.startsWith(WELES_ARTIFACT_PREFIX)) {
    throw new RequestFailure(Number('400'), 'artifact locator must use the private Weles recordings namespace');
  }
  if (value.includes('\\') || value.includes('\0') || value.includes('?') || value.includes('#')) {
    throw new RequestFailure(Number('400'), 'artifact locator contains a forbidden character');
  }
  for (const character of value) {
    if (character.charCodeAt(Number(false)) < Number('32')) {
      throw new RequestFailure(Number('400'), 'artifact locator contains a control character');
    }
  }

  const relative = value.slice(WELES_ARTIFACT_PREFIX.length);
  const parts = relative.split('/');
  if (parts.length < Number('2') || parts.some((part) => !part || part === '.' || part === '..')) {
    throw new RequestFailure(Number('400'), 'artifact locator has an invalid path');
  }
  const runId = parts.at(Number(false)) ?? '';
  const runParts = runId.split('-');
  const expectedRunPartLengths = ['8', '4', '4', '4', '12'].map(Number);
  if (runId !== runId.toLowerCase()
    || runParts.length !== expectedRunPartLengths.length
    || runParts.some((part, index) => part.length !== expectedRunPartLengths.at(index) || !/^[a-f\d]+$/.test(part))) {
    throw new RequestFailure(Number('400'), 'artifact locator must contain a canonical run UUID');
  }
  return value;
}

export function normalizeArtifactLocators(value: unknown): ArtifactLocatorSet {
  if (!isRecord(value)) throw new RequestFailure(Number('400'), 'artifacts must be an object');
  const keys = Object.keys(value);
  if (keys.length !== ARTIFACT_KINDS.length || keys.some((key) => !ARTIFACT_KINDS.includes(key as ArtifactKind))) {
    throw new RequestFailure(Number('400'), `artifacts must contain exactly ${ARTIFACT_KINDS.join(', ')}`);
  }

  const normalized = { screenshots: [], videos: [], dom: [], logs: [] } as ArtifactLocatorSet;
  let count = Number(false);
  for (const kind of ARTIFACT_KINDS) {
    const entries = value[kind];
    if (!Array.isArray(entries)) throw new RequestFailure(Number('400'), `artifacts.${kind} must be an array`);
    count += entries.length;
    if (count > MAX_ARTIFACT_COUNT) throw new RequestFailure(Number('413'), 'too many artifact locators');
    normalized[kind] = entries.map(canonicalWelesArtifactUri);
  }
  return normalized;
}

function signaturePayload(uri: string, expires: string): string {
  return `GET\n${OBJECT_PATH}\n${uri}\n${expires}`;
}

function artifactSignature(uri: string, expires: string, secret: string): string {
  return createHmac('sha256', secret).update(signaturePayload(uri, expires)).digest('hex');
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function signedObjectUrl(uri: string, expires: string, config: ArtifactDeliveryConfig): string {
  const url = new URL(OBJECT_PATH, config.publicBaseUrl);
  url.searchParams.set('uri', uri);
  url.searchParams.set('expires', expires);
  url.searchParams.set('signature', artifactSignature(uri, expires, config.signingSecret));
  return url.toString();
}

export function signArtifactLocators(
  value: unknown,
  config: ArtifactDeliveryConfig,
  nowMilliseconds: number = Date.now(),
): SignedArtifactResponse {
  const artifacts = normalizeArtifactLocators(value);
  const nowSeconds = Math.floor(nowMilliseconds / MILLIS_PER_SECOND);
  const expires = String(nowSeconds + config.ttlSeconds);
  const signed = { screenshots: [], videos: [], dom: [], logs: [] } as ArtifactLocatorSet;
  for (const kind of ARTIFACT_KINDS) {
    signed[kind] = artifacts[kind].map((uri) => signedObjectUrl(uri, expires, config));
  }
  return {
    artifacts: signed,
    expires_at: new Date(Number(expires) * MILLIS_PER_SECOND).toISOString(),
  };
}

function bearerAuthorized(request: IncomingMessage, expectedToken: string): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  return constantTimeTextEqual(token, expectedToken);
}

function verifiedObjectUri(url: URL, config: ArtifactDeliveryConfig, nowMilliseconds: number): string {
  const keys = [...url.searchParams.keys()];
  if (keys.length !== Number('3')
    || !['uri', 'expires', 'signature'].every((key) => url.searchParams.getAll(key).length === Number(true))) {
    throw new RequestFailure(Number('403'), 'invalid artifact signature');
  }
  const uri = canonicalWelesArtifactUri(url.searchParams.get('uri'));
  const expires = url.searchParams.get('expires') ?? '';
  const signature = url.searchParams.get('signature') ?? '';
  if (!/^\d+$/.test(expires) || !/^[a-f\d]+$/.test(signature) || signature.length !== HMAC_HEX_LENGTH) {
    throw new RequestFailure(Number('403'), 'invalid artifact signature');
  }
  const nowSeconds = Math.floor(nowMilliseconds / MILLIS_PER_SECOND);
  const expirySeconds = Number(expires);
  if (!Number.isSafeInteger(expirySeconds) || String(expirySeconds) !== expires
    || expirySeconds <= nowSeconds
    || expirySeconds - nowSeconds > config.ttlSeconds) {
    throw new RequestFailure(Number('403'), 'artifact URL expired');
  }
  const expected = artifactSignature(uri, expires, config.signingSecret);
  if (!constantTimeTextEqual(signature, expected)) {
    throw new RequestFailure(Number('403'), 'invalid artifact signature');
  }
  return uri;
}

async function requestJson(request: IncomingMessage): Promise<unknown> {
  let size = Number(false);
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) throw new RequestFailure(Number('413'), 'request body too large');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestFailure(Number('400'), 'request body must be valid JSON');
  }
}

function secureResponseHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'private, no-store, max-age=0');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
}

function jsonResponse(response: ServerResponse, status: number, body: unknown): void {
  secureResponseHeaders(response);
  const encoded = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Content-Length', String(encoded.byteLength));
  response.end(encoded);
}

function applyAllowedOrigin(request: IncomingMessage, response: ServerResponse, config: ArtifactDeliveryConfig): void {
  if (!config.allowedOrigin || request.headers.origin !== config.allowedOrigin) return;
  response.setHeader('Access-Control-Allow-Origin', config.allowedOrigin);
  response.setHeader('Vary', 'Origin');
}

async function deliverObject(
  request: IncomingMessage,
  response: ServerResponse,
  uri: string,
  config: ArtifactDeliveryConfig,
): Promise<void> {
  const headers: Record<string, string> = { Authorization: `Bearer ${config.stadoApiToken}` };
  if (typeof request.headers.range === 'string') headers.Range = request.headers.range;
  const upstream = await fetch(`${config.stadoApiUrl}/api/object?uri=${encodeURIComponent(uri)}`, {
    method: 'GET',
    headers,
    redirect: 'error',
  });
  if (upstream.status === Number('404')) {
    jsonResponse(response, Number('404'), { error: 'artifact not found' });
    return;
  }
  if (upstream.status === Number('416')) {
    secureResponseHeaders(response);
    applyAllowedOrigin(request, response, config);
    response.statusCode = upstream.status;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) response.setHeader('Content-Range', contentRange);
    response.end();
    return;
  }
  if (upstream.status !== Number('200') && upstream.status !== Number('206')) {
    jsonResponse(response, Number('502'), { error: 'private artifact backend unavailable' });
    return;
  }

  secureResponseHeaders(response);
  applyAllowedOrigin(request, response, config);
  response.statusCode = upstream.status;
  for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const value = upstream.headers.get(header);
    if (value) response.setHeader(header, value);
  }
  const contentType = upstream.headers.get('content-type') ?? 'application/octet-stream';
  const fileName = uri.split('/').at(-Number(true)) ?? 'artifact';
  const disposition = contentType.toLowerCase().startsWith('text/html') ? 'attachment' : 'inline';
  response.setHeader('Content-Disposition', `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  if (!upstream.body) {
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body as never), response);
}

function boundedSubscriptionText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.slice(Number(false), MAX_SUBSCRIPTION_TEXT_LENGTH);
}

function publicSubscriptionRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RequestFailure(Number('502'), 'Weles subscription store returned an invalid row');
  }
  const serviceName = boundedSubscriptionText(value.service_name);
  const provider = boundedSubscriptionText(value.provider);
  if (!serviceName || !provider) {
    throw new RequestFailure(Number('502'), 'Weles subscription store returned an incomplete row');
  }
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const monthlyCost = typeof value.monthly_cost_usd === 'number'
    && Number.isFinite(value.monthly_cost_usd)
    ? value.monthly_cost_usd
    : null;
  return {
    id: boundedSubscriptionText(value.id),
    service_name: serviceName,
    provider,
    account_identifier: boundedSubscriptionText(value.account_identifier),
    status: boundedSubscriptionText(value.status),
    plan: boundedSubscriptionText(value.plan),
    monthly_cost_usd: monthlyCost,
    expires_at: boundedSubscriptionText(value.expires_at),
    last_verified_at: boundedSubscriptionText(value.last_verified_at),
    label: boundedSubscriptionText(metadata.note),
  };
}

async function listServiceSubscriptions(config: ArtifactDeliveryConfig): Promise<Record<string, unknown>[]> {
  const query = new URLSearchParams({
    select: 'id,service_name,provider,account_identifier,status,plan,monthly_cost_usd,expires_at,last_verified_at,metadata',
    order: 'service_name.asc',
    limit: String(MAX_SUBSCRIPTION_COUNT),
  });
  const upstream = await fetch(
    `${config.databaseUrl}/rest/v1/service_subscriptions?${query.toString()}`,
    {
      method: 'GET',
      headers: {
        apikey: config.databaseToken,
        Authorization: `Bearer ${config.databaseToken}`,
      },
      redirect: 'error',
      signal: AbortSignal.timeout(Number('10000')),
    },
  );
  if (!upstream.ok) {
    throw new RequestFailure(Number('502'), 'Weles subscription store unavailable');
  }
  const body: unknown = await upstream.json();
  if (!Array.isArray(body)) {
    throw new RequestFailure(Number('502'), 'Weles subscription store returned an invalid response');
  }
  return body.map(publicSubscriptionRow);
}

export async function handleArtifactDeliveryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ArtifactDeliveryConfig,
): Promise<void> {
  try {
    const url = new URL(request.url ?? '/', 'http://weles.internal');
    if (request.method === 'GET' && url.pathname === SUBSCRIPTIONS_PATH && !url.search) {
      if (!bearerAuthorized(request, config.subscriptionsToken)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        throw new RequestFailure(Number('401'), 'unauthorized');
      }
      jsonResponse(response, Number('200'), {
        subscriptions: await listServiceSubscriptions(config),
      });
      return;
    }
    if (request.method === 'POST' && url.pathname === SIGN_PATH) {
      if (!bearerAuthorized(request, config.clientToken)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        throw new RequestFailure(Number('401'), 'unauthorized');
      }
      if (String(request.headers['content-type'] ?? '').split(';').at(Number(false))?.trim() !== 'application/json') {
        throw new RequestFailure(Number('415'), 'content type must be application/json');
      }
      const body = await requestJson(request);
      if (!isRecord(body) || Object.keys(body).length !== Number(true) || !Object.hasOwn(body, 'artifacts')) {
        throw new RequestFailure(Number('400'), 'request must contain exactly artifacts');
      }
      jsonResponse(response, Number('200'), signArtifactLocators(body.artifacts, config));
      return;
    }
    if (request.method === 'GET' && url.pathname === OBJECT_PATH) {
      const uri = verifiedObjectUri(url, config, Date.now());
      await deliverObject(request, response, uri, config);
      return;
    }
    throw new RequestFailure(Number('404'), 'not found');
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    const status = error instanceof RequestFailure ? error.status : Number('500');
    const message = error instanceof RequestFailure ? error.message : 'internal server error';
    jsonResponse(response, status, { error: message });
  }
}

export function createArtifactDeliveryServer(config: ArtifactDeliveryConfig): Server {
  return createServer((request, response) => {
    void handleArtifactDeliveryRequest(request, response, config);
  });
}
