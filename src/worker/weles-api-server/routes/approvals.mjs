import {
  OPERATOR_ANSWERS, answerOperatorRequest, isAbandoned, listOperatorRequests, readOperatorRequest,
} from '../../../operator/request.mjs';
import { json, readBody, requireTokenAuthorization } from '../http-exchange.mjs';

// Process liveness belongs to the worker that owns the request, never to the
// laptop displaying it. Reading exposes records; an answer is written here,
// on the host whose run waits on the record, because that run watches the
// record and nothing written on another machine reaches it.

/**
 * POST /operator-requests/:id/answer `{answer, detail}`: the operator tells
 * the waiting run `approved`, `not_received` or `cancel`. A closed request
 * is refused with how it ended (409), because no run waits for the answer.
 */
export async function respondToOperatorAnswer(req, res, id) {
  if (!requireTokenAuthorization(req, res)) return;
  if (!/^[0-9a-f-]{8,64}$/.test(id)) {
    json(res, 400, { ok: false, error: 'invalid_operator_request_id' });
    return;
  }
  let body;
  try { body = await readBody(req); }
  catch (error) { json(res, 400, { ok: false, error: error.message }); return; }
  const answer = typeof body.answer === 'string' ? body.answer : '';
  if (!OPERATOR_ANSWERS.includes(answer)) {
    json(res, 400, { ok: false, error: `answer must be one of ${OPERATOR_ANSWERS.join(', ')}` });
    return;
  }
  let request;
  try {
    request = readOperatorRequest(id);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    json(res, 404, { ok: false, error: 'operator_request_not_found', id });
    return;
  }
  if (request.closed_at) {
    json(res, 409, {
      ok: false, error: 'operator_request_closed', id,
      message: `closed at ${request.closed_at}: ${request.outcome_detail}; no run waits for an answer`,
    });
    return;
  }
  const answered = answerOperatorRequest(id, answer, typeof body.detail === 'string' ? body.detail : '');
  json(res, 200, { ok: true, requests: [{ ...answered, abandoned: isAbandoned(answered) }] });
}

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
