// The HTTP plumbing of the artifact delivery service: bearer checks, JSON
// bodies, the response headers every answer carries, streaming one
// object out of Stado, and the subscription rows the Oko console reads.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readSetting } from '../../state/skarbiec-records.js';
import type { ArtifactDeliveryConfig } from './delivery-config.js';

export class RequestFailure extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function constantTimeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function bearerAuthorized(
  request: IncomingMessage,
  expectedToken: string,
): boolean {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  return constantTimeTextEqual(token, expectedToken);
}

export async function requestJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new RequestFailure(400, 'request body must be valid JSON');
  }
}

export function secureResponseHeaders(response: ServerResponse): void {
  response.setHeader('Cache-Control', 'private, no-store, max-age=0');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
}

export function jsonResponse(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  secureResponseHeaders(response);
  const encoded = Buffer.from(JSON.stringify(body));
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Content-Length', String(encoded.byteLength));
  response.end(encoded);
}

export function applyAllowedOrigin(
  request: IncomingMessage,
  response: ServerResponse,
  config: ArtifactDeliveryConfig,
): void {
  if (!config.allowedOrigin || request.headers.origin !== config.allowedOrigin)
    return;
  response.setHeader('Access-Control-Allow-Origin', config.allowedOrigin);
  response.setHeader('Vary', 'Origin');
}

export async function deliverObject(
  request: IncomingMessage,
  response: ServerResponse,
  uri: string,
  config: ArtifactDeliveryConfig,
): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${config.stadoApiToken}`,
  };
  if (typeof request.headers.range === 'string')
    headers.Range = request.headers.range;
  const upstream = await fetch(
    `${config.stadoApiUrl}/api/object?uri=${encodeURIComponent(uri)}`,
    {
      method: 'GET',
      headers,
      redirect: 'error',
    },
  );
  if (upstream.status === 404) {
    jsonResponse(response, 404, { error: 'artifact not found' });
    return;
  }
  if (upstream.status === 416) {
    secureResponseHeaders(response);
    applyAllowedOrigin(request, response, config);
    response.statusCode = upstream.status;
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) response.setHeader('Content-Range', contentRange);
    response.end();
    return;
  }
  if (upstream.status !== 200 && upstream.status !== 206) {
    jsonResponse(response, 502, {
      error: 'private artifact backend unavailable',
    });
    return;
  }

  secureResponseHeaders(response);
  applyAllowedOrigin(request, response, config);
  response.statusCode = upstream.status;
  for (const header of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
  ]) {
    const value = upstream.headers.get(header);
    if (value) response.setHeader(header, value);
  }
  const contentType =
    upstream.headers.get('content-type') ?? 'application/octet-stream';
  const fileName = uri.split('/').at(-1) ?? 'artifact';
  const disposition = contentType.toLowerCase().startsWith('text/html')
    ? 'attachment'
    : 'inline';
  response.setHeader(
    'Content-Disposition',
    `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
  );
  if (!upstream.body) {
    response.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body as never), response);
}

function subscriptionText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function publicSubscriptionRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new RequestFailure(
      502,
      'Weles subscription store returned an invalid row',
    );
  }
  const serviceName = subscriptionText(value.service_name);
  const provider = subscriptionText(value.provider);
  if (!serviceName || !provider) {
    throw new RequestFailure(
      502,
      'Weles subscription store returned an incomplete row',
    );
  }
  const metadata = isRecord(value.metadata) ? value.metadata : {};
  const monthlyCost =
    typeof value.monthly_cost_usd === 'number' &&
    Number.isFinite(value.monthly_cost_usd)
      ? value.monthly_cost_usd
      : null;
  return {
    id: subscriptionText(value.id),
    service_name: serviceName,
    provider,
    account_identifier: subscriptionText(value.account_identifier),
    status: subscriptionText(value.status),
    plan: subscriptionText(value.plan),
    monthly_cost_usd: monthlyCost,
    expires_at: subscriptionText(value.expires_at),
    last_verified_at: subscriptionText(value.last_verified_at),
    label: subscriptionText(metadata.note),
  };
}

export async function listServiceSubscriptions(
  _config: ArtifactDeliveryConfig,
): Promise<Record<string, unknown>[]> {
  const rows = readSetting<unknown[]>('service_subscriptions', []);
  if (!Array.isArray(rows))
    throw new RequestFailure(
      502,
      'Weles subscription store returned an invalid response',
    );
  return rows
    .map(publicSubscriptionRow)
    .sort((left, right) =>
      String(left.service_name).localeCompare(String(right.service_name)),
    );
}
