// One-time backfill: walk every active social_accounts row not in
// character_social_accounts and invoke autoBindCharacter to establish the
// missing link. Without bindings, action trajectories fail at
// _shared/action-runner.mjs:80 (FAIL: no character linked) and per-platform
// profile fields can't be propagated from the character row.
//
// Run: node scripts/admin/backfill_character_bindings.mjs
// Dry-run: DRY_RUN=1 node scripts/admin/backfill_character_bindings.mjs

import { autoBindCharacter } from '../trajectories/lib/character-bind.mjs';

const URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
const DRY = process.env.DRY_RUN === '1';
if (!URL || !KEY) { console.log('FAIL: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function unlinkedAccounts() {
  const sa = await fetch(`${URL}/rest/v1/social_accounts?is_active=eq.true&select=id,platform,username`, { headers: H }).then(r => r.ok ? r.json() : []);
  const links = await fetch(`${URL}/rest/v1/character_social_accounts?select=social_account_id`, { headers: H }).then(r => r.ok ? r.json() : []);
  const linked = new Set(links.map((l) => l.social_account_id));
  return sa.filter(a => !linked.has(a.id));
}

const rows = await unlinkedAccounts();
console.log(`unlinked active accounts: ${rows.length}`);
const byPlatform = rows.reduce((acc, r) => { acc[r.platform] = (acc[r.platform] || 0) + 1; return acc; }, {});
console.log('by platform:', JSON.stringify(byPlatform));
if (DRY) { console.log('DRY_RUN=1 — exiting without binding'); process.exit(0); }

let bound = 0, generated = 0, errored = 0;
const stats = {};
for (const r of rows) {
  try {
    const result = await autoBindCharacter(r.username, r.platform);
    const status = result?.status ?? (result?.id ? 'bound_existing' : 'unknown');
    stats[status] = (stats[status] || 0) + 1;
    if (status === 'bound' || result?.id) bound += 1;
    if (status === 'bound' && result?.character_generated) generated += 1;
    console.log(`[${r.platform}/${r.username}] ${JSON.stringify(result).slice(0, 200)}`);
  } catch (e) {
    errored += 1;
    console.log(`[${r.platform}/${r.username}] ERR ${e.message?.slice(0, 200)}`);
  }
}
console.log(`\nDONE: ${rows.length} processed, ${bound} bound, ${generated} new chars, ${errored} errored`);
console.log('status histogram:', JSON.stringify(stats));
