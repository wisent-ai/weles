// Assign a static-IP proxy URL to a Weles account in Skarbiec.
// Usage: node scripts/admin/assign_static_ip.mjs <account_item> <proxy_url> [--force]
import {
  listAccounts,
  readAccount,
  updateAccountMetadata,
} from '../trajectories/_shared/skarbiec_accounts.mjs';

const [, , ACCOUNT_ID, PROXY_URL, ...rest] = process.argv;
const FORCE = rest.includes('--force');
if (!ACCOUNT_ID || !PROXY_URL) {
  console.error('usage: assign_static_ip.mjs <account_item> <proxy_url> [--force]');
  process.exit(2);
}
if (!/^https?:\/\//.test(PROXY_URL)) {
  console.error(`refusing: proxy_url must start with http:// or https:// (got "${PROXY_URL.slice(0, 30)}...")`);
  process.exit(2);
}


const seed = readAccount(ACCOUNT_ID);
const characterId = seed.metadata?.character_id ?? seed.metadata?.character?.id ?? null;
const targets = characterId
  ? listAccounts().filter((account) =>
      (account.metadata?.character_id ?? account.metadata?.character?.id) === characterId)
  : [seed];
console.log(`[assign_static_ip] seed=${seed.platform}/${seed.username} character_id=${characterId ?? '(none)'} → ${targets.length} target row(s)`);

for (const row of targets) {
  const existing = row.metadata?.proxy?.exit_ip_url;
  if (existing && existing !== PROXY_URL && !FORCE) {
    console.error(`refuse: ${row.platform}/${row.username} already has exit_ip_url=${existing.slice(0, 60)}... — pass --force to overwrite`);
    process.exit(3);
  }
}

for (const row of targets) {
  updateAccountMetadata(row.id, {
    proxy: {
      ...((row.metadata ?? {}).proxy ?? {}),
      exit_ip_url: PROXY_URL,
      exit_ip_assigned_at: new Date().toISOString(),
    },
  });
  console.log(`  ✓ ${row.platform}/${row.username}  exit_ip_url=${PROXY_URL.replace(/\/\/[^@]*@/, '//***@')}`);
}
console.log(`[assign_static_ip] done — ${targets.length} row(s) bound to single static IP`);
