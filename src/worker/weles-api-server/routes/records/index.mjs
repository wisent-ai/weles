// The record routes of the one Weles process: the trajectory accounts and
// runtime settings Weles keeps in Skarbiec, served to products that manage
// them (echo-web) without a database. Actions are started through POST /run
// with detached: true, the process's own execution path.
//
//   POST /records/accounts/list    { platform? }                     -> { accounts }
//   POST /records/accounts/get     { account_id }                    -> { account }
//   POST /records/accounts/upsert  { account: { platform, username, password?, metadata?, display_name? } } -> { account }
//                                  (without a password only the profile is written; an existing credential is kept)
//   POST /records/accounts/update  { account_id, patch: { metadata?, active? } } -> { account }
//   POST /records/settings/get     { keys: [...] }                   -> { settings: [{ key, value }] }
//   POST /records/settings/set     { key, value }                    -> { key }
//   POST /records/services/list    { category }                      -> { services }
//                                  (each service's balance, last probe and top-up policy as its record states them; no credential)
//
// The data owner is src/state/skarbiec-records.ts (handed in by the entry
// point); these routes add transport, validation and refusals, nothing else.
// An account leaves without its password. Callers hold the general Weles API
// bearer. Every answer is { ok: true, data } or { ok: false, code, error }, and
// every request leaves one event:record_route line in the unit log.

import {
  json,
  readBody,
  requireTokenAuthorization,
} from '../../http-exchange.mjs';
import {
  HTTP_INVALID_REQUEST,
  HTTP_NOT_FOUND,
  HTTP_OK,
  HTTP_RECORD_FAILED,
} from './constants.mjs';
import {
  accountId,
  accountInput,
  accountPatch,
  platformFilter,
  serviceCategory,
  RecordRequestRefused,
  settingInput,
  settingKeys,
} from './request.mjs';

class RecordNotFound extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecordNotFound';
  }
}

function publicAccount(record) {
  return {
    id: record.id,
    platform: record.platform,
    username: record.username,
    is_active: record.active,
    display_name: record.context?.display_name ?? record.username,
    metadata: record.metadata,
  };
}

function existing(records, id) {
  const record = records.readAccount(id);
  if (!record) throw new RecordNotFound(`no Weles account record ${id}`);
  return record;
}

/**
 * What a product may read of a service record: the balance its trajectory
 * last wrote, the probe of its upstream, and the top-up policy the operator
 * stated on it. Each is null when the record does not state it.
 */
function publicService(record) {
  const stated = (key) => (Object.hasOwn(record, key) ? record[key] : null);
  return {
    id: record.id,
    display_name: stated('display_name'),
    category: record.category,
    balance_usd:
      typeof record.balance_usd === 'number' ? record.balance_usd : null,
    last_balance_check: stated('last_balance_check'),
    last_probe: stated('last_probe'),
    topup: stated('topup'),
  };
}

const ROUTES = {
  '/records/accounts/list': (records, body) => ({
    accounts: records.listAccounts(platformFilter(body)).map(publicAccount),
  }),
  '/records/services/list': (records, body) => ({
    services: records
      .listServiceMetadata(serviceCategory(body))
      .map(publicService),
  }),
  '/records/accounts/get': (records, body) => ({
    account: publicAccount(existing(records, accountId(body))),
  }),
  '/records/accounts/upsert': (records, body) => {
    const input = accountInput(body);
    const id = input.password
      ? records.putAccount(input)
      : records.putAccountProfile(input);
    return { account: publicAccount(existing(records, id)) };
  },
  '/records/accounts/update': (records, body) => {
    const id = accountId(body);
    const patch = accountPatch(body);
    existing(records, id);
    records.updateAccount(id, patch);
    return { account: publicAccount(existing(records, id)) };
  },
  '/records/settings/get': (records, body) => ({
    settings: settingKeys(body).map((key) => ({
      key,
      value: records.readSetting(key, null),
    })),
  }),
  '/records/settings/set': (records, body) => {
    const setting = settingInput(body);
    records.writeSetting(setting.key, setting.value);
    return { key: setting.key };
  },
};

const REFUSALS = [
  {
    type: RecordRequestRefused,
    status: HTTP_INVALID_REQUEST,
    code: 'invalid_request',
  },
  { type: RecordNotFound, status: HTTP_NOT_FOUND, code: 'record_not_found' },
];
const RECORD_FAILURE = { status: HTTP_RECORD_FAILED, code: 'record_failed' };
const SERVED = { status: HTTP_OK, code: 'ok' };

export function isRecordRoute(req, url) {
  return req.method === 'POST' && Object.hasOwn(ROUTES, url.pathname);
}

export async function respondToRecord(req, res, url, records) {
  if (!requireTokenAuthorization(req, res)) return;
  const started = Date.now();
  let outcome = SERVED;
  try {
    const data = ROUTES[url.pathname](records, await readBody(req));
    json(res, HTTP_OK, { ok: true, data });
  } catch (error) {
    const { status, code } =
      REFUSALS.find(({ type }) => error instanceof type) || RECORD_FAILURE;
    outcome = { status, code, message: String(error?.message || error) };
    json(res, status, {
      ok: false,
      code,
      error: `${code}: ${outcome.message}`,
      ...(error instanceof RecordRequestRefused ? { field: error.field } : {}),
    });
  } finally {
    console.log(
      JSON.stringify({
        event: 'record_route',
        route: url.pathname,
        status: outcome.status,
        code: outcome.code,
        ...(outcome.message ? { error: outcome.message } : {}),
        elapsed_ms: Date.now() - started,
      }),
    );
  }
}
