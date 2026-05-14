// Assign a static-IP proxy URL to a social_accounts row.
//
// Usage:
//   node scripts/admin/assign_static_ip.mjs <account_id> <proxy_url>
//
// Behavior:
//   - Reads the row, looks at metadata.character_id (if set).
//   - If character_id is set: writes the same proxy_url into
//     metadata.proxy.exit_ip_url for THIS row AND every other row whose
//     metadata.character_id matches. One identity = one IP across platforms.
//   - If character_id is NOT set: writes only to this row. No accidental
//     fan-out to unrelated accounts.
//   - Refuses to overwrite an existing exit_ip_url unless --force is passed,
//     so a cross-identity collision (same character_id but different IPs
//     already assigned) surfaces loudly.

const [, , ACCOUNT_ID, PROXY_URL, ...rest] = process.argv;
const FORCE = rest.includes('--force');
if (!ACCOUNT_ID || !PROXY_URL) {
  console.error('usage: assign_static_ip.mjs <account_id> <proxy_url> [--force]');
  process.exit(2);
}
if (!/^https?:\/\//.test(PROXY_URL)) {
  console.error(`refusing: proxy_url must start with http:// or https:// (got "${PROXY_URL.slice(0, 30)}...")`);
  process.exit(2);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required');
  process.exit(2);
}

const headers = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
  Prefer: 'return=representation',
};

async function fetchRow(id) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${id}&select=id,platform,username,metadata`, { headers });
  if (!r.ok) throw new Error(`fetch ${id}: ${r.status} ${await r.text()}`);
  const rows = await r.json();
  return rows[0] ?? null;
}

async function fetchByCharacter(characterId) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?metadata->>character_id=eq.${characterId}&select=id,platform,username,metadata`, { headers });
  if (!r.ok) throw new Error(`fetch character ${characterId}: ${r.status} ${await r.text()}`);
  return await r.json();
}

async function patchRow(id, newMeta) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?id=eq.${id}`, {
    method: 'PATCH', headers, body: JSON.stringify({ metadata: newMeta }),
  });
  if (!r.ok) throw new Error(`patch ${id}: ${r.status} ${await r.text()}`);
  return (await r.json())[0];
}

const seed = await fetchRow(ACCOUNT_ID);
if (!seed) { console.error(`no row with id=${ACCOUNT_ID}`); process.exit(1); }
const characterId = seed.metadata?.character_id ?? null;
const targets = characterId ? await fetchByCharacter(characterId) : [seed];
console.log(`[assign_static_ip] seed=${seed.platform}/${seed.username} character_id=${characterId ?? '(none)'} → ${targets.length} target row(s)`);

for (const row of targets) {
  const existing = row.metadata?.proxy?.exit_ip_url;
  if (existing && existing !== PROXY_URL && !FORCE) {
    console.error(`refuse: ${row.platform}/${row.username} already has exit_ip_url=${existing.slice(0, 60)}... — pass --force to overwrite`);
    process.exit(3);
  }
}

for (const row of targets) {
  const newMeta = {
    ...(row.metadata ?? {}),
    proxy: {
      ...((row.metadata ?? {}).proxy ?? {}),
      exit_ip_url: PROXY_URL,
      exit_ip_assigned_at: new Date().toISOString(),
    },
  };
  const patched = await patchRow(row.id, newMeta);
  console.log(`  ✓ ${patched.platform}/${patched.username}  exit_ip_url=${PROXY_URL.replace(/\/\/[^@]*@/, '//***@')}`);
}
console.log(`[assign_static_ip] done — ${targets.length} row(s) bound to single static IP`);
