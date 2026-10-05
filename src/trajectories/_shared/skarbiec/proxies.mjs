// The proxy fleet, read from and written to Skarbiec — the one credential
// store. Each `weles-*-proxy` item carries credentials in its fields and all
// non-secret configuration and observed state in its context. A row's
// provider is derived from its endpoint and its pool type is what the item's
// context declares as `proxy_type` (isp, mobile or residential).
//
// Nothing here prints a secret.

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { activeSkarbiecBinary } from '../../../_shared/skarbiec-runtime.mjs';
import { providerFromHost } from '../../../../dist/proxy/policy.js';
import { proxyTypeOf, stickyCredentials } from '../../../../dist/proxy/sources/provider_credentials.js';

const HOME = os.homedir();
let resolvedSkarbiecBinary;
const VAULT = process.env.SKARBIEC_VAULT_FILE ?? path.join(HOME, '.stado', 'skarbiec.vault.json');

function skarbiec(args, input) {
  return execFileSync(resolvedSkarbiecBinary ??= activeSkarbiecBinary(), args, {
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
  const host = context.host ?? null;
  return {
    id,
    displayName: context.display_name ?? id,
    host,
    port: context.port ? Number(context.port) : null,
    provider: typeof context.provider === 'string' ? context.provider : (host ? providerFromHost(host, fields.username) : undefined) ?? null,
    proxyType: proxyTypeOf(context.proxy_type) ?? null,
    username: fields.username ?? null,
    password: fields.password ?? null,
    notes: context.notes ?? '',
    balanceUsd: context.balance_usd ?? null,
    metadata: context.metadata ?? {},
    context,
  };
}

// The credentials for one sticky session on this row, pinned to a country
// and, for a provider that takes one, the row's city for `platform`.
export function stickySession(proxy, sessionId, country, platform) {
  const metadata = proxy.metadata ?? {};
  const city = String(metadata.city_overrides?.[platform] ?? metadata.city ?? '').toLowerCase().replace(/\s+/g, '_') || undefined;
  return stickyCredentials(proxy.provider ?? undefined, proxy.proxyType ?? undefined, { username: proxy.username, password: proxy.password }, { country, city, sessionId });
}

// An include list such as `oxylabs/mobile,packetstream,brightdata/residential`:
// each entry names a provider and, after a slash, one pool type; a provider
// alone admits every rotating pool it has. Parsed into a predicate over rows.
export function parseInclude(text) {
  const entries = String(text ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    .map((entry) => { const [provider, proxyType] = entry.split('/'); return { provider, proxyType: proxyType || null }; });
  return (proxy) => entries.some((e) => e.provider === proxy.provider && (e.proxyType === null || e.proxyType === proxy.proxyType));
}

// Splits the fleet into the rotating rows an include predicate admits, and
// the rows that cannot be judged because their item declares no pool type.
export function rotatingRows(include) {
  const rows = listProxies().filter((proxy) => proxy.host && proxy.port && proxy.username && proxy.password);
  return {
    candidates: rows.filter((proxy) => proxy.proxyType !== null && proxy.proxyType !== 'isp' && include(proxy)),
    undeclared: rows.filter((proxy) => proxy.proxyType === null),
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
