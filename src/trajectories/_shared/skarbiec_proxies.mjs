// The proxy fleet, read from and written to Skarbiec — the one credential
// store. Each `weles-*-proxy` item carries credentials in its fields and all
// non-secret configuration and observed state in its context.
//
// Nothing here prints a secret.

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { activeSkarbiecBinary } from '../../_shared/skarbiec-runtime.mjs';

const HOME = os.homedir();
const SKARBIEC = activeSkarbiecBinary();
const VAULT = process.env.SKARBIEC_VAULT_FILE ?? path.join(HOME, '.stado', 'skarbiec.vault.json');

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

function readItem(id) {
  return JSON.parse(skarbiec(['get', id]));
}

function proxyRecord(id, document) {
  const fields = document?.fields ?? {};
  const context = document?.context ?? {};
  return {
    id,
    displayName: context.display_name ?? id,
    host: context.host ?? null,
    port: context.port ? Number(context.port) : null,
    username: fields.username ?? null,
    password: fields.password ?? null,
    notes: context.notes ?? '',
    balanceUsd: context.balance_usd ?? null,
    metadata: context.metadata ?? {},
    context,
  };
}

export function listProxies() {
  const items = JSON.parse(skarbiec(['list']));
  return items
    .filter((item) => !item.deleted && item.kind === 'proxy')
    .map((item) => item.name ?? item.id)
    .filter((id) => /^weles-.*-proxy$/.test(id))
    .map((id) => proxyRecord(id, readItem(id)));
}

export function getProxy(id) {
  return proxyRecord(id, readItem(id));
}

export function findProxyByDisplayName(name) {
  const wanted = String(name).toLowerCase();
  return listProxies().find(
    (proxy) => proxy.displayName.toLowerCase() === wanted
      || proxy.displayName.toLowerCase().includes(wanted)
      || proxy.id.includes(wanted.replace(/[^a-z0-9]+/g, '-')),
  ) ?? null;
}

// Merge, never replace: probe results and balance updates land beside the
// attributes already in the item's context; credentials are never touched.
export function persistProxyContext(id, patch) {
  const document = readItem(id);
  document.context = { ...(document.context ?? {}), ...patch };
  skarbiec(['set-json', id], JSON.stringify(document));
  return true;
}
