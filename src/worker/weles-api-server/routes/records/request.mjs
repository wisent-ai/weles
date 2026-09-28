// What a caller may ask of a record route, checked before Skarbiec is touched.
// A request outside these bounds is refused with the field that broke it.

import {
  MAX_DISPLAY_NAME_CHARS,
  MAX_PASSWORD_CHARS,
  MAX_PLATFORM_CHARS,
  MAX_SETTING_KEYS,
  MAX_USERNAME_CHARS,
} from './constants.mjs';

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

function text(value, field, maximum, { required }) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new RecordRequestRefused(field, 'is required');
    return undefined;
  }
  if (typeof value !== 'string' || value.length > maximum) {
    throw new RecordRequestRefused(field, `must be text of at most ${maximum} characters`);
  }
  return value;
}

export function platformFilter(body) {
  return text(object(body, 'body').platform, 'platform', MAX_PLATFORM_CHARS, { required: false });
}

export function accountId(body) {
  return text(object(body, 'body').account_id, 'account_id', MAX_USERNAME_CHARS, { required: true });
}

export function accountInput(body) {
  const account = object(object(body, 'body').account, 'account');
  const metadata = Object.hasOwn(account, 'metadata') ? object(account.metadata, 'account.metadata') : {};
  return {
    platform: text(account.platform, 'account.platform', MAX_PLATFORM_CHARS, { required: true }),
    username: text(account.username, 'account.username', MAX_USERNAME_CHARS, { required: true }),
    password: text(account.password, 'account.password', MAX_PASSWORD_CHARS, { required: true }),
    displayName: text(account.display_name, 'account.display_name', MAX_DISPLAY_NAME_CHARS, { required: false }),
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

export function jobInput(body) {
  const input = object(body, 'body');
  return {
    action: text(input.action, 'action', MAX_PLATFORM_CHARS, { required: true }),
    accountId: text(input.account_id, 'account_id', MAX_USERNAME_CHARS, { required: false }) ?? '',
    params: Object.hasOwn(input, 'params') ? object(input.params, 'params') : {},
  };
}

export function settingKeys(body) {
  const keys = object(body, 'body').keys;
  if (!Array.isArray(keys) || !keys.length || keys.length > MAX_SETTING_KEYS || keys.some((key) => typeof key !== 'string')) {
    throw new RecordRequestRefused('keys', `must be a list of 1 to ${MAX_SETTING_KEYS} setting names`);
  }
  return keys;
}

export function settingInput(body) {
  const input = object(body, 'body');
  if (!Object.hasOwn(input, 'value')) throw new RecordRequestRefused('value', 'is required');
  return { key: text(input.key, 'key', MAX_PLATFORM_CHARS, { required: true }), value: input.value };
}
