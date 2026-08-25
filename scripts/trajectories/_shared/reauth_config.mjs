// Reauth configuration, read from and written to Skarbiec — the one credential
// store this fleet has. The Supabase project these orchestrators were written
// against is gone; nothing here reads a database.
//
// Two facts about the shape, both learned from the rows themselves:
//   - `fields.value.metadata` carries the map the runners read, and it is a JSON
//     string in some rows and an object in others;
//   - the agent identity and HMAC secret in it belong to the wisent-app agent,
//     not to one provider, so a row that lacks them may borrow them from a
//     sibling row rather than keeping a second copy of the same secret.
//
// Nothing here prints a secret. The router address never comes from a row: it
// is resolved through Stado, and it is logged.

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const SKARBIEC = process.env.SKARBIEC_BIN ?? path.join(HOME, '.stado', 'bin', 'skarbiec');
const VAULT = process.env.SKARBIEC_VAULT_FILE ?? path.join(HOME, '.stado', 'skarbiec.vault.json');
const STADO = process.env.STADO_BIN ?? path.join(HOME, '.stado', 'bin', 'stado');
// What a row must carry. The signing secret is deliberately not here: it belongs
// to the agent's own item, the copies in these rows had drifted, and requiring a
// copy would mean requiring the trap to stay in place.
const REQUIRED = [
  'WISENT_APP_AGENT_ID',
  'WISENT_DONOR_USER_ID',
];


// Where Brama is, answered by Stado. The launcher-injected
// STADO_MODEL_ROUTER_URL wins where a unit carries it; a bare unit (the
// launchd reauth jobs get only HOME and PATH) asks this host's Stado service
// directory. The address belongs to placement, and placement is Stado's — a
// configuration row remembers identity, never a route.
export function stadoRouterUrl() {
  const fromEnv = String(process.env.STADO_MODEL_ROUTER_URL || '').trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const raw = execFileSync(STADO, ['service', 'directory', 'endpoint', 'brama', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}`,
    },
  });
  const url = String(JSON.parse(raw)?.url ?? '').trim();
  if (!url) throw new Error('Stado answered no endpoint for brama');
  return url.replace(/\/+$/, '');
}

function skarbiec(args, input) {
  return execFileSync(SKARBIEC, args, {
    input,
    encoding: 'utf8',
    env: {
      ...process.env,
      SKARBIEC_VAULT_FILE: VAULT,
      PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH ?? '/usr/bin:/bin'}`,
    },
  });
}

function readItem(item) {
  const document = JSON.parse(skarbiec(['get', item]));
  const value = document?.fields?.value;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  const raw = parsed?.metadata;
  const metadata = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return { document, parsed, metadata: metadata ?? null, metadataWasText: typeof raw === 'string' };
}

// The row named first wins; a row that carries no metadata contributes nothing.
// `fallbackItem` exists for the identity keys, which are the same for every
// provider this agent donates for.
export function loadFromSkarbiec(item, fallbackItem) {
  const own = readItem(item);
  let metadata = own.metadata ? { ...own.metadata } : {};
  if (fallbackItem) {
    const sibling = readItem(fallbackItem);
    if (sibling.metadata) {
      for (const [key, value] of Object.entries(sibling.metadata)) {
        if (metadata[key] === undefined) metadata[key] = value;
      }
    }
  }
  const missing = REQUIRED.filter((key) => !metadata[key]);
  if (missing.length) {
    throw new Error(`${item} carries no ${missing.join(', ')} in Skarbiec`);
  }
  const agentId = metadata.WISENT_APP_AGENT_ID;
  // The signing secret belongs to the agent, not to a provider row, and the
  // copy inside this row is stale: Brama answered 200 to a read signed with
  // `agent:<id>` and 401 to the same read signed with the row's copy. Read the
  // agent's own item and keep the row's copy out of the signature entirely.
  const own_secret = resolveAgentSecret(agentId);
  const copy = metadata.WISENT_APP_AGENT_AUTH_SECRET;
  if (own_secret && copy && own_secret !== copy) {
    console.error(
      `agent:${agentId} carries a different secret than ${item}; signing with the agent item`,
    );
  }
  return {
    store: 'skarbiec',
    item,
    metadataWasText: own.metadataWasText,
    agentId,
    hmacSecret: own_secret || metadata.WISENT_APP_AGENT_AUTH_SECRET,
    donorUserId: metadata.WISENT_DONOR_USER_ID,
    rawMeta: metadata,
    activeTokenExpiresAt: Number(metadata.active_token_expires_at) || 0,
  };
}

// The agent's signing secret, from the one item that owns it.
export function resolveAgentSecret(agentId) {
  const fromEnv = process.env.WISENT_APP_AGENT_AUTH_SECRET;
  if (fromEnv) return fromEnv;
  try {
    const document = JSON.parse(skarbiec(['get', `agent:${agentId}`]));
    const fields = document?.fields ?? {};
    const secret = fields.value ?? fields.secret ?? fields.token;
    return typeof secret === 'string' && secret.trim() ? secret.trim() : null;
  } catch (error) {
    console.error(`no agent secret: agent:${agentId} unreadable (${error.message.split('\n')[0]})`);
    return null;
  }
}

// Merge, never replace: this map also carries the identity and the HMAC secret,
// and a bare write would take them with it.
export function persistToSkarbiec(cfg, patch) {
  const { document, parsed, metadataWasText } = readItem(cfg.item);
  const metadata = { ...(cfg.rawMeta ?? {}), ...patch };
  parsed.metadata = metadataWasText ? JSON.stringify(metadata) : metadata;
  document.fields.value = parsed;
  skarbiec(['set-json', cfg.item], JSON.stringify(document));
}
// Account material for a provider login, from the vault item that holds it.
//
// The login helpers read these rows out of the Weles database; the same
// accounts are in Skarbiec as `login` items with `username` and `password`
// fields and the method in their context. A helper that only knows the database
// fails with "no login row" while the credential sits one read away.
export function loginFromSkarbiec(item) {
  const document = JSON.parse(skarbiec(['get', item]));
  const fields = document?.fields ?? {};
  const email = fields.username ?? fields.email;
  const password = fields.password;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
    throw new Error(`${item} carries no username/password in Skarbiec`);
  }
  return {
    id: item,
    displayName: document?.context?.account_ref ?? item,
    email,
    password,
    loginMethod: document?.context?.login_method ?? 'google_sso',
  };
}

// Prefer the router that answers over the one a row remembers.
// A configuration row pointed at `http://100.120.25.24:8080` -- the gateway's
// tailnet address, which it does not bind, because it listens on loopback and is
// reached through stable local adapters. The runner failed with `fetch failed`
// and no address for a day. A declaration that the world contradicts is worth
// exactly what the world says, so this checks and substitutes the loopback of
// the same port when the configured host refuses.
export async function reachableRouterUrl(configured) {
  const candidates = [configured];
  try {
    const url = new URL(configured);
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      candidates.push(`${url.protocol}//127.0.0.1:${url.port || '8080'}`);
    }
  } catch {
    // An unparseable address is left exactly as configured.
  }
  // Brama binds loopback; the canonical listener is the last resort behind
  // every stale row and proxy alias.
  candidates.push('http://127.0.0.1:8080');
  for (const candidate of [...new Set(candidates)]) {
    try {
      // Probe a route only the model router answers. `/health` is not one: a
      // stale address can now belong to anyone's site, and on 2026-08-25 it
      // did — the row's host returned a 404 page for /health, this helper
      // accepted it, and the runner died one request later with
      // `list subscriptions -> 404` against a server that never was Brama.
      // The catalogue refuses an unsigned caller with 401 and serves a
      // signed one with 200; both answers carry the router's identity.
      const answer = await fetch(`${candidate}/v1/models`, {
        signal: AbortSignal.timeout(Number('4000')),
      });
      if (answer.status === 401 || answer.status === 200) {
        if (candidate !== configured) {
          console.error(`router ${configured} refused; using ${candidate}`);
        }
        return candidate;
      }
      console.error(
        `router ${candidate} answered /v1/models ${answer.status}; not the model router`,
      );
    } catch (error) {
      console.error(`router ${candidate} unreachable: ${error.cause?.code ?? error.message}`);
    }
  }
  return configured;
}

// The client token lives beside every other credential on this fleet, under
// `<client>-model-router`, so read it from there when the environment is silent.
export function resolveBearer(agentId) {
  const fromEnv = process.env.WISENT_APP_MODEL_ROUTER_TOKEN;
  if (fromEnv) return fromEnv;
  const item = `${agentId}-model-router`;
  try {
    // `get` answers with the whole item document; `--field` is not a selector it
    // honours, and passing the document straight through as a header value is
    // how a bearer ended up printed in a log.
    const document = JSON.parse(skarbiec(['get', item]));
    const fields = document?.fields ?? {};
    const token = fields.token ?? fields.value;
    return typeof token === 'string' && token.trim() ? token.trim() : null;
  } catch (error) {
    console.error(`no bearer: ${item} unreadable (${error.message.split('\n')[0]})`);
    return null;
  }
}