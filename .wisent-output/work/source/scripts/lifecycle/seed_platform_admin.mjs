#!/usr/bin/env node
// Legacy entrypoint retained only to enumerate platform-admin contracts that
// still require external scoped Skarbiec provisioning. Weles never accepts
// plaintext login or API material here and never persists it in its database.
//
// Usage:
//   node scripts/lifecycle/seed_platform_admin.mjs check [--platform <key>]

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

function catalogPath() {
  const configured = process.env.WELES_PLATFORM_ADMIN_CATALOG?.trim();
  if (configured) return isAbsolute(configured) ? configured : join(repoRoot, configured);
  return join(repoRoot, '..', 'entitlements-rotator', 'platform-admin-credentials.json');
}

function loadCatalog() {
  const data = JSON.parse(readFileSync(catalogPath(), 'utf8'));
  if (data.name !== 'platform-admin-credentials') throw new Error('invalid platform-admin-credentials catalog');
  return data;
}


function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) { out[key] = true; } else { out[key] = next; i += 1; }
  }
  return out;
}


function check(catalog, args) {
  const only = typeof args.platform === 'string' ? args.platform : null;
  const platforms = catalog.platforms
    .filter((row) => !only || row.platform === only)
    .map((row) => ({
      platform: row.platform,
      login_method: row.login_method,
      credential_id: row.credential_id,
      status: 'external_skarbiec_provisioning_required',
    }));
  return { total: platforms.length, platforms };
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] ?? 'check';
  const catalog = loadCatalog();
  if (command === 'check') return check(catalog, args);
  throw new Error('Direct credential seeding was removed; provision exact scoped Skarbiec items and run check [--platform <key>]');
}

export { loadCatalog, check, main };

if (import.meta.url === `file://${process.argv[Number('1')]}`) {
  main()
    .then((result) => { console.log(JSON.stringify(result, null, Number('2'))); })
    .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(Number('1')); });
}
