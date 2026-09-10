import { createHash, createHmac } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ArtifactDeliveryConfig } from './delivery-config.js';
import {
  RequestFailure,
  bearerAuthorized,
  constantTimeTextEqual,
  deliverObject,
  isRecord,
  jsonResponse,
  listServiceSubscriptions,
  requestJson,
} from './delivery-http.js';

export { loadArtifactDeliveryConfig, type ArtifactDeliveryConfig } from './delivery-config.js';

const SIGN_PATH = '/v1/artifacts/sign';
const OBJECT_PATH = '/v1/artifacts/object';
const SUBSCRIPTIONS_PATH = '/v1/subscriptions';
const WELES_ARTIFACT_PREFIX = 'stado://weles/recordings/';
const ARTIFACT_KINDS = ['screenshots', 'videos', 'dom', 'logs'] as const;
const MILLIS_PER_SECOND = Number('1000');
const MAX_ARTIFACT_COUNT = Number('10000');
const MAX_LOCATOR_LENGTH = Number('4096');
const HMAC_HEX_LENGTH = Number('64');

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
