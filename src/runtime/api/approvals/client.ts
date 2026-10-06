import type { OperatorAnswer, OperatorRequest } from '../../../operator/request.mjs' with { 'resolution-mode': 'import' };
import { operatorJson, welesOperatorConnection, type WelesApiOptions } from '../connection.js';

export type ObservedOperatorRequest = OperatorRequest & { abandoned: boolean | null };

function parseRequest(value: unknown): ObservedOperatorRequest {
  const row = value as Partial<ObservedOperatorRequest> | null;
  if (!row || row.schema !== 'wisent.weles-operator-request.v1'
      || typeof row.id !== 'string' || typeof row.host !== 'string'
      || typeof row.instruction !== 'string' || !Array.isArray(row.pages)
      || (row.abandoned !== null && typeof row.abandoned !== 'boolean')) {
    throw new Error('Weles returned an invalid operator request or no worker process observation');
  }
  return row as ObservedOperatorRequest;
}

/** Read the worker's records and its process observation, not local lookalikes. */
export async function readOperatorRequests(
  input: { id?: string; limit?: number; openOnly?: boolean } = {},
  options: WelesApiOptions = {},
): Promise<ObservedOperatorRequest[]> {
  const query = new URLSearchParams();
  if (input.limit !== undefined) query.set('limit', String(input.limit));
  if (input.openOnly) query.set('open', 'true');
  const path = input.id ? `/operator-requests/${encodeURIComponent(input.id)}`
    : `/operator-requests${query.size ? `?${query}` : ''}`;
  const connection = welesOperatorConnection(path, options);
  try {
    const response = await connection.fetch(connection.endpoint, {
      method: 'GET', headers: connection.headers, redirect: 'error',
    });
    const body = await operatorJson(response);
    if (!response.ok || body.ok !== true) {
      throw new Error(`HTTP ${response.status}: ${body.error ?? 'Weles refused the operator request read'}`);
    }
    if (!Array.isArray(body.requests)) throw new Error('Weles returned no operator request list');
    const rows = body.requests.map(parseRequest);
    if (input.id && (rows.length !== 1 || rows[0].id !== input.id)) {
      throw new Error('Weles returned a different operator request');
    }
    return rows;
  } catch (cause) {
    throw new Error(`GET ${connection.endpoint}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/**
 * Tell the run waiting on a request on the managed worker what happened:
 * `approved`, `not_received` (Weles asks the provider to send it again) or
 * `cancel`. The answer is written on the worker, beside the record the run
 * watches; a closed request is refused with how it ended.
 */
export async function answerOperatorRequest(
  id: string,
  answer: OperatorAnswer,
  detail: string,
  options: WelesApiOptions = {},
): Promise<ObservedOperatorRequest> {
  const connection = welesOperatorConnection(`/operator-requests/${encodeURIComponent(id)}/answer`, options);
  try {
    const response = await connection.fetch(connection.endpoint, {
      method: 'POST', headers: connection.headers, redirect: 'error',
      body: JSON.stringify({ answer, detail }),
    });
    const body = await operatorJson(response);
    if (!response.ok || body.ok !== true) {
      const said = [body.error, body.message].filter((part) => typeof part === 'string' && part).join(': ');
      throw new Error(`HTTP ${response.status}: ${said || 'Weles refused the answer'}`);
    }
    if (!Array.isArray(body.requests) || body.requests.length !== 1) {
      throw new Error('Weles returned no answered operator request');
    }
    const row = parseRequest(body.requests[0]);
    if (row.id !== id) throw new Error('Weles answered a different operator request');
    return row;
  } catch (cause) {
    throw new Error(`POST ${connection.endpoint}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}
