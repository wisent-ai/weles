#!/usr/bin/env node
// Bulk domain availability search with rate-limit handling.
// Reads candidate names from a file (one per line, SLD only — TLD appended automatically).
// Usage: node scripts/domains/bulk_search.mjs <candidates.txt> [tld]
//   tld defaults to .com — use .ai for .ai domains
//
// Output: only AVAILABLE + non-premium domains, one per line.

import { checkDomain } from '../../dist/utils/email/provision.js';
import { readFileSync } from 'node:fs';
import { humanIdlePause } from '../../dist/human/mouse.js';

const [file, tld = '.com'] = process.argv.slice(2);
if (!file) { console.error('Usage: bulk_search.mjs <candidates.txt> [tld]'); process.exit(1); }

const names = readFileSync(file, 'utf-8')
  .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

console.log(`Checking ${names.length} candidates for ${tld} availability...`);

for (let i = 0; i < names.length; i++) {
  const domain = `${names[i]}${tld}`;
  try {
    const r = await checkDomain(domain);
    if (r.available && !r.premium) console.log(`AVAILABLE: ${domain}`);
    // Rate limit: Namecheap allows ~20 req/min on the check endpoint
    if (i > 0 && i % 15 === 0) {
      console.error(`  [rate-limit pause at ${i}/${names.length}]`);
      await humanIdlePause('long');
    } else {
      await humanIdlePause('deliberate');
    }
  } catch (e) {
    const msg = e.message?.slice(0, 80) ?? '';
    if (msg.includes('Too many requests')) {
      console.error(`  [rate-limited at ${i}/${names.length}, waiting 90s]`);
      await humanIdlePause('long');
      i--; // retry this one
    } else {
      console.error(`ERROR: ${domain} — ${msg}`);
    }
  }
}
console.log('Done.');
