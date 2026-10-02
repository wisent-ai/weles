import { isAbandoned, listOperatorRequests, readOperatorRequest } from '../../../operator/request.mjs';
import { json, requireTokenAuthorization } from '../http-exchange.mjs';

// Process liveness belongs to the worker that owns the request, never to the
// laptop displaying it. This route exposes records; it cannot approve a prompt.
export function respondToOperatorRequests(req, res, url) {
  if (!requireTokenAuthorization(req, res)) return;
  const id = url.pathname.slice('/operator-requests'.length).replace(/^\//, '');
  if (id) {
    if (!/^[0-9a-f-]{8,64}$/.test(id)) {
      json(res, 400, { ok: false, error: 'invalid_operator_request_id' });
      return;
    }
    try {
      const request = readOperatorRequest(id);
      json(res, 200, { ok: true, requests: [{ ...request, abandoned: isAbandoned(request) }] });
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      json(res, 404, { ok: false, error: 'operator_request_not_found', id });
    }
    return;
  }
  const rawLimit = url.searchParams.get('limit');
  const limit = rawLimit === null ? undefined : Number(rawLimit);
  const open = url.searchParams.get('open');
  if ((limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0))
      || (open !== null && open !== 'true' && open !== 'false')) {
    json(res, 400, { ok: false, error: 'limit must be a positive integer and open must be true or false' });
    return;
  }
  const requests = listOperatorRequests({ limit, openOnly: open === 'true' })
    .map((request) => ({ ...request, abandoned: isAbandoned(request) }));
  json(res, 200, { ok: true, requests });
}
