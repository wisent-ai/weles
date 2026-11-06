// The artifact delivery service's HTTP surface: the subscription listing,
// signing a run's locators, and delivering an object through a signed URL.
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { constants } from 'node:http2';
import {
  MILLIS_PER_SECOND,
  OBJECT_PATH,
  SIGN_PATH,
  artifactSignature,
  signArtifactLocators,
  signedObjectParts,
} from '../artifact-delivery.js';
import type { ArtifactDeliveryConfig } from '../delivery-config.js';
import {
  RequestFailure,
  bearerAuthorized,
  constantTimeTextEqual,
  deliverObject,
  isRecord,
  jsonResponse,
  listServiceSubscriptions,
  requestJson,
} from '../delivery-http.js';
import { canonicalWelesArtifactUri } from './locator.js';

const SUBSCRIPTIONS_PATH = '/v1/subscriptions';
/** The base a request's path is read against; only its path and query are used. */
const REQUEST_BASE = 'http://weles.internal';

const {
  HTTP_STATUS_BAD_REQUEST,
  HTTP_STATUS_FORBIDDEN,
  HTTP_STATUS_INTERNAL_SERVER_ERROR,
  HTTP_STATUS_NOT_FOUND,
  HTTP_STATUS_OK,
  HTTP_STATUS_UNAUTHORIZED,
  HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
} = constants;

function verifiedObjectUri(
  url: URL,
  config: ArtifactDeliveryConfig,
  nowMilliseconds: number,
): string {
  const parts = signedObjectParts(url);
  if (!parts || !/^\d+$/.test(parts.expires))
    throw new RequestFailure(
      HTTP_STATUS_FORBIDDEN,
      'invalid artifact signature',
    );
  const uri = canonicalWelesArtifactUri(parts.uri);
  const { expires, signature } = parts;
  const nowSeconds = Math.floor(nowMilliseconds / MILLIS_PER_SECOND);
  const expirySeconds = Number(expires);
  if (
    !Number.isSafeInteger(expirySeconds) ||
    String(expirySeconds) !== expires ||
    expirySeconds <= nowSeconds ||
    expirySeconds - nowSeconds > config.ttlSeconds
  )
    throw new RequestFailure(HTTP_STATUS_FORBIDDEN, 'artifact URL expired');
  const expected = artifactSignature(uri, expires, config.signingSecret);
  if (!constantTimeTextEqual(signature, expected))
    throw new RequestFailure(
      HTTP_STATUS_FORBIDDEN,
      'invalid artifact signature',
    );
  return uri;
}

function requireBearer(
  request: IncomingMessage,
  response: ServerResponse,
  token: string,
): void {
  if (bearerAuthorized(request, token)) return;
  response.setHeader('WWW-Authenticate', 'Bearer');
  throw new RequestFailure(HTTP_STATUS_UNAUTHORIZED, 'unauthorized');
}

/** The signing request's locators: a JSON body holding exactly `artifacts`. */
async function signingBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (contentType === undefined)
    throw new RequestFailure(
      HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
      'content type must be application/json; the request sent none',
    );
  const [mediaType] = contentType.split(';');
  if (mediaType.trim() !== 'application/json')
    throw new RequestFailure(
      HTTP_STATUS_UNSUPPORTED_MEDIA_TYPE,
      'content type must be application/json',
    );
  const body = await requestJson(request);
  const [only, ...other] = isRecord(body) ? Object.keys(body) : [];
  if (!isRecord(body) || only !== 'artifacts' || other.length)
    throw new RequestFailure(
      HTTP_STATUS_BAD_REQUEST,
      'request must contain exactly artifacts',
    );
  return body.artifacts;
}

async function route(
  request: IncomingMessage,
  response: ServerResponse,
  config: ArtifactDeliveryConfig,
): Promise<void> {
  if (request.url === undefined)
    throw new RequestFailure(HTTP_STATUS_BAD_REQUEST, 'request has no URL');
  const url = new URL(request.url, REQUEST_BASE);
  if (
    request.method === 'GET' &&
    url.pathname === SUBSCRIPTIONS_PATH &&
    !url.search
  ) {
    requireBearer(request, response, config.subscriptionsToken);
    jsonResponse(response, HTTP_STATUS_OK, {
      subscriptions: await listServiceSubscriptions(config),
    });
    return;
  }
  if (request.method === 'POST' && url.pathname === SIGN_PATH) {
    requireBearer(request, response, config.clientToken);
    const artifacts = await signingBody(request);
    jsonResponse(
      response,
      HTTP_STATUS_OK,
      signArtifactLocators(artifacts, config),
    );
    return;
  }
  if (request.method === 'GET' && url.pathname === OBJECT_PATH) {
    const uri = verifiedObjectUri(url, config, Date.now());
    await deliverObject(request, response, uri, config);
    return;
  }
  throw new RequestFailure(HTTP_STATUS_NOT_FOUND, 'not found');
}

export async function handleArtifactDeliveryRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ArtifactDeliveryConfig,
): Promise<void> {
  try {
    await route(request, response, config);
  } catch (error) {
    if (response.headersSent) {
      response.destroy(error instanceof Error ? error : undefined);
      return;
    }
    if (error instanceof RequestFailure) {
      jsonResponse(response, error.status, { error: error.message });
      return;
    }
    // The caller is told only that the service failed; the cause is the
    // operator's and goes to the service's own error stream.
    console.error('artifact delivery request failed', error);
    jsonResponse(response, HTTP_STATUS_INTERNAL_SERVER_ERROR, {
      error: 'internal server error',
    });
  }
}

export function createArtifactDeliveryServer(
  config: ArtifactDeliveryConfig,
): Server {
  return createServer((request, response) => {
    void handleArtifactDeliveryRequest(request, response, config);
  });
}
