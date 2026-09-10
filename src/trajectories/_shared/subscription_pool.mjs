// Brama's subscription pool, from this side of the wire.
//
// Three reauth runners — codex, claude, kimi — each asked which subscriptions
// exist, banked a fresh credential and retired the stale rows, and each spelled
// the route and the body itself. Brama replaced eleven per-audience inventory
// invocations with one capability
// (https://brama.wisent.com/docs/command-surface), so the routes those copies
// named are gone from its router: GET, POST and DELETE /v1/subscriptions/:agent_id
// answer nothing now. One shape for every audience means one shape here too,
// which is why the path and the two bodies live in this file and not in three.
//
// The identity contract is unchanged: the bearer plus the HMAC trio still sign
// the exact raw body, and the pool narrows its answer to the agent that
// signature proves. That is also why no caller here sends `agent_id`: the pool
// derives the owner from the proof, and an agent-scoped caller that sends one
// is refused with `agent_id is derived from the proven identity and must not be
// sent`.
//
// Each runner keeps its own refusal wording, so these return the response
// rather than deciding what an unhappy status means.

export const SUBSCRIPTION_POOL_PATH = '/v1/subscription-pool';

/** The pool, narrowed by the caller's proof. Rows carry `id`, not `subscription_id`. */
export function listPool(baseUrl, headers) {
  return fetch(`${baseUrl}${SUBSCRIPTION_POOL_PATH}`, { headers });
}

/** The exact body a bank writes: the credential, on the coordinate Brama already names. */
export function bankBody(fields) {
  return JSON.stringify({ action: 'bank', ...fields });
}

/** The exact body a retirement writes. Retirement is a journal record, not a vault deletion. */
export function retireBody(subscriptionId) {
  return JSON.stringify({ action: 'retire', subscription_id: subscriptionId });
}

/** One signed write to the pool. `body` is already serialized, because the signature covers it. */
export function writePool(baseUrl, headers, body) {
  return fetch(`${baseUrl}${SUBSCRIPTION_POOL_PATH}`, { method: 'POST', headers, body });
}
