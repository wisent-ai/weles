// What a caller may ask of a record route, checked before Skarbiec is touched.
// A request of the wrong shape is refused with the field that broke it. No
// length or count is chosen here: the item-id shapes Skarbiec records enforce
// (src/state/skarbiec-records.ts) and Skarbiec's own refusal decide what a
// record can hold, and that refusal is returned.

export class RecordRequestRefused extends Error {
  constructor(field, message) {
    super(`${field}: ${message}`);
    this.name = 'RecordRequestRefused';
    this.field = field;
  }
}

function object(value, field) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new RecordRequestRefused(field, 'must be a JSON object');
  }
  return value;
}

function text(value, field, { required }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RecordRequestRefused(field, 'is required');
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new RecordRequestRefused(field, 'must be text');
  }
  return value;
}

export function platformFilter(body) {
  return text(object(body, 'body').platform, 'platform', { required: false });
}

export function accountId(body) {
  return text(object(body, 'body').account_id, 'account_id', { required: true });
}

export function accountInput(body) {
  const account = object(object(body, 'body').account, 'account');
  const metadata = Object.hasOwn(account, 'metadata') ? object(account.metadata, 'account.metadata') : {};
  return {
    platform: text(account.platform, 'account.platform', { required: true }),
    username: text(account.username, 'account.username', { required: true }),
    password: text(account.password, 'account.password', { required: false }),
    displayName: text(account.display_name, 'account.display_name', { required: false }),
    metadata,
  };
}

export function accountPatch(body) {
  const patch = object(object(body, 'body').patch, 'patch');
  const result = {};
  if (Object.hasOwn(patch, 'metadata')) result.metadata = object(patch.metadata, 'patch.metadata');
  if (Object.hasOwn(patch, 'active')) {
    if (typeof patch.active !== 'boolean') throw new RecordRequestRefused('patch.active', 'must be true or false');
    result.active = patch.active;
  }
  if (!Object.keys(result).length) throw new RecordRequestRefused('patch', 'names neither metadata nor active');
  return result;
}

export function settingKeys(body) {
  const keys = object(body, 'body').keys;
  if (!Array.isArray(keys) || !keys.length || keys.some((key) => typeof key !== 'string')) {
    throw new RecordRequestRefused('keys', 'must be a non-empty list of setting names');
  }
  return keys;
}

export function settingInput(body) {
  const input = object(body, 'body');
  if (!Object.hasOwn(input, 'value')) throw new RecordRequestRefused('value', 'is required');
  return { key: text(input.key, 'key', { required: true }), value: input.value };
}
