// Backfill every active Skarbiec account without an embedded character.
// Without bindings, action trajectories refuse with "no character linked".
//
// Run: node scripts/admin/backfill_character_bindings.mjs

import { autoBindCharacter } from '../trajectories/lib/character-bind.mjs';
import { listAccounts } from '../trajectories/_shared/skarbiec_accounts.mjs';


const rows = listAccounts().filter((account) =>
  !account.metadata?.character && !account.metadata?.character_id);
console.log(`unlinked active accounts: ${rows.length}`);
const byPlatform = rows.reduce((acc, r) => { acc[r.platform] = (acc[r.platform] || 0) + 1; return acc; }, {});
console.log('by platform:', JSON.stringify(byPlatform));

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
