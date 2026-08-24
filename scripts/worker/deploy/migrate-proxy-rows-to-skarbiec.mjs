// Move the proxy fleet's configuration out of the database and into Skarbiec.
//
// The `service_credentials` rows with `category = 'proxy'` carry what the vault
// items lack — host, port, category, notes, dashboard, balance — while the
// `weles-*-proxy` items carry the credentials. After this runs, each item is a
// complete proxy record and the rows are no longer needed by any reader.
//
// Deterministic mapping only: a row named in ROW_TO_ITEM enriches that exact
// item; any other proxy row mints `weles-<row id>-proxy` with its own login
// material. The source row is deleted only after its complete replacement can
// be read back from Skarbiec. Reruns therefore finish an interrupted cutover
// without creating a second source of truth or printing secret material.

// Run where the database env and the fleet vault both exist:
//   node scripts/worker/deploy/migrate-proxy-rows-to-skarbiec.mjs

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const SKARBIEC = process.env.SKARBIEC_BIN ?? path.join(HOME, '.stado', 'bin', 'skarbiec');
const VAULT = process.env.SKARBIEC_VAULT_FILE ?? path.join(HOME, '.stado', 'skarbiec.vault.json');

const ROW_TO_ITEM = {
  oxylabs: 'weles-oxylabs-residential-proxy',
  oxylabs_mobile: 'weles-oxylabs-mobile-proxy',
  iproyal: 'weles-iproyal-proxy',
  iproyal_mobile: 'weles-iproyal-mobile-proxy',
  brightdata: 'weles-brightdata-proxy',
  packetstream: 'weles-packetstream-proxy',
  pingproxies: 'weles-pingproxies-proxy',
};

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

function databaseEnv() {
  const url = (process.env.WELES_DATABASE_URL ?? process.env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  const key = process.env.WELES_DATABASE_TOKEN ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
  if (!url || !key) throw new Error('WELES_DATABASE_URL and WELES_DATABASE_TOKEN are required');
  return { url, key };
}

async function proxyRows() {
  const { url, key } = databaseEnv();
  const response = await fetch(
    `${url}/rest/v1/service_credentials?category=eq.proxy&select=*`,
    { headers: { apikey: key, Authorization: `Bearer ${key}` } },
  );
  if (!response.ok) throw new Error(`read proxy rows -> ${response.status}`);
  const rows = await response.json();
  // A configuration row that carries an agent identity is a misfiled reauth
  // row, not a proxy.
  return rows.filter((row) => !(row.metadata && row.metadata.WISENT_APP_AGENT_ID));
}

async function deleteProxyRow(id) {
  const { url, key } = databaseEnv();
  const response = await fetch(
    `${url}/rest/v1/service_credentials?id=eq.${encodeURIComponent(id)}&category=eq.proxy`,
    {
      method: 'DELETE',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: 'return=minimal',
      },
    },
  );
  if (!response.ok) throw new Error(`delete migrated proxy row ${id} -> ${response.status}`);
}

function readItem(id) {
  try {
    return JSON.parse(skarbiec(['get', id]));
  } catch {
    return null;
  }
}

// The enrichment a row contributes: everything nonsecret a consumer needs to
// pick and use a proxy. Credentials stay whatever the item already has; a
// minted item receives the row's login material as its credentials. The proxy
// kind's field schema is credentials-only, so the address and every other
// nonsecret attribute live in the item's free-form context.
function enrichment(row) {
  const context = {
    source_kind: 'proxy',
    provider_row: row.id,
    display_name: row.display_name ?? row.id,
  };
  if (row.proxy_host) context.host = String(row.proxy_host);
  if (row.proxy_port) context.port = String(row.proxy_port);
  if (row.notes) context.notes = row.notes;
  if (row.dashboard_url) context.dashboard_url = row.dashboard_url;
  if (row.api_key_env_var) context.api_key_env_var = row.api_key_env_var;
  if (row.balance_usd !== null && row.balance_usd !== undefined) {
    context.balance_usd = row.balance_usd;
  }
  if (row.metadata && typeof row.metadata === 'object' && Object.keys(row.metadata).length) {
    context.metadata = row.metadata;
  }
  return { context };
}

function mergeItem(id, row) {
  const document = readItem(id);
  if (!document) return false;
  const { context } = enrichment(row);
  document.context = { ...(document.context ?? {}), ...context };
  skarbiec(['set-json', id], JSON.stringify(document));
  return Boolean(readItem(id)?.context?.provider_row === row.id);
}

function mintItem(id, row) {
  // A proxy item is credentials plus address; a row without a usable login
  // (expired, KYC-pending, never registered) is refused rather than deleted.
  if (!row.login_email || !row.login_password) return false;
  const { context } = enrichment(row);
  const pairs = [`username=${row.login_email}`, `password=${row.login_password}`];
  skarbiec(['set', id, '--type', 'proxy', ...pairs]);
  const document = readItem(id);
  document.context = { ...(document.context ?? {}), ...context };
  skarbiec(['set-json', id], JSON.stringify(document));
  const saved = readItem(id);
  return Boolean(
    saved?.fields?.username
      && saved?.fields?.password
      && saved?.context?.provider_row === row.id,
  );
}

const rows = await proxyRows();
let migrated = 0;
for (const row of rows) {
  const mapped = ROW_TO_ITEM[row.id];
  let item = mapped;
  let complete = mapped ? mergeItem(mapped, row) : false;
  if (!complete) {
    item = `weles-${row.id.replace(/_/g, '-')}-proxy`;
    complete = readItem(item) ? mergeItem(item, row) : mintItem(item, row);
  }
  if (!complete) {
    throw new Error(`refusing to delete proxy row ${row.id}: no complete Skarbiec replacement`);
  }
  await deleteProxyRow(row.id);
  migrated += 1;
  console.log(`migrated ${row.id} to ${item} and deleted the source row`);
}
console.log(`${migrated} proxy row(s) moved to Skarbiec`);
