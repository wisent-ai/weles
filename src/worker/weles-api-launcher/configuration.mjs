/**
 * What the launcher reads before it starts anything: the environment files the
 * deployment owns, in the order they override each other, the startup fields
 * this service must hold before it answers, the action catalogue this build
 * may dispatch, and the declared names the console reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { refuse } from './running.mjs';

export const REPO = resolve(import.meta.dirname, '..', '..', '..');
export const HOME = process.env.HOME || homedir();
export const PATH_PREFIX = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';

/** The env files the deployment owns, in the order they override each other. */
export const ENV_FILES = [
  join(HOME, 'weles/var/worker.env'),
  join(HOME, 'weles/var/worker-content.env'),
  join(HOME, '.config/weles/worker.env'),
  join(HOME, '.weles/secrets.env'),
  join(HOME, '.stado/weles-model.env'),
];

/** Startup fields this service must hold before it answers anything. */
export const STARTUP_FIELDS = [
  ['WELES_API_TOKEN', 'weles-echo-api-token-bootstrap', 'echo-weles-api', 'token', true],
  ['BRAMA_WELES_REAUTH_TOKEN', 'weles-brama-reauth-token-bootstrap', 'brama-weles-reauth', 'token', true],
  ['WELES_STADO_OBJECT_API_TOKEN', 'weles-object-token-bootstrap', 'weles-object-api', 'token', false],
  ['WELES_STADO_MODEL_ROUTER_TOKEN', 'weles-model-router-token-bootstrap', 'weles-model-router', 'token', false],
  ['WELES_STADO_MODEL_ROUTER_AGENT_ID', 'weles-model-agent-id-bootstrap', 'weles-model-agent-auth', 'id', false],
  ['WELES_STADO_MODEL_ROUTER_AGENT_AUTH_SECRET', 'weles-model-agent-secret-bootstrap', 'weles-model-agent-auth', 'agent_auth_secret', false],
  ['WELES_PUBLIC_API_BEARER', 'weles-spis-public-bearer-bootstrap', 'weles-spis-public-admission', 'token', true],
  ['WELES_PUBLIC_API_ORGANIZATION_ID', 'weles-spis-public-organization-bootstrap', 'weles-spis-public-admission', 'organization_id', true],
  ['WELES_RECEIPT_KEY_ID', 'weles-spis-receipt-key-id-bootstrap', 'weles-spis-public-admission', 'receipt_key_id', true],
  ['WELES_RECEIPT_KEY_SET_VERSION', 'weles-spis-receipt-key-set-version-bootstrap', 'weles-spis-public-admission', 'receipt_key_set_version', true],
  ['WELES_RECEIPT_PRIVATE_KEY', 'weles-spis-receipt-private-key-bootstrap', 'weles-spis-public-admission', 'receipt_private_key', true],
  ['WELES_RECEIPT_PUBLIC_KEYS_JSON', 'weles-spis-receipt-public-keys-bootstrap', 'weles-spis-public-admission', 'receipt_public_keys_json', true],
];

/** `KEY=value` lines the deployment wrote, with the shell quoting it used. */
export function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

/** The exact action catalog this build may dispatch. */
export function actionAllowlist() {
  const path = join(REPO, 'src/worker/deploy/weles-action-allowlist.txt');
  const actions = readFileSync(path, 'utf8').split(/\r?\n/).map((action) => action.trim()).filter(Boolean);
  const invalid = !actions.length
    || new Set(actions).size !== actions.length
    || actions.some((action) => !/^[a-z_]+$/.test(action));
  if (invalid) refuse(`invalid exact Weles action catalog: ${path}`);
  return actions.join(',');
}

/**
 * What this build may run by name: the declared engagements, and the declared
 * observations.
 *
 * One loader per family, and each is the module admission itself uses, so a
 * declaration naming a reviewed trajectory that is not in this tree refuses
 * the unit here — before it serves — instead of failing the first caller who
 * happens to name that engagement or that observation. The names are exported
 * so the desktop console can state what the host is authorized to run.
 */
export async function declaredNames(relativeModule, loader) {
  const module = join(REPO, relativeModule);
  let load;
  try {
    ({ [loader]: load } = await import(module));
  } catch (error) {
    refuse(`${loader} is unavailable: ${module}: ${error.message}`);
  }
  try {
    return [...load(REPO).keys()].join(',');
  } catch (error) {
    refuse(error.message);
  }
}

