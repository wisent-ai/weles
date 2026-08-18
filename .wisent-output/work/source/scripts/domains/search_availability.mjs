#!/usr/bin/env node
// Batch-check domain availability via Namecheap.
// Usage: node scripts/domains/search_availability.mjs <domain1> [domain2] ...
//   or:  node scripts/domains/search_availability.mjs --generate <count>
//
// --generate: use the LLM suggestor to generate <count> candidate names first,
//             then check availability. Requires claude CLI with available quota.

import { checkDomain } from '../../dist/utils/email/provision.js';
import { suggestDomainName } from '../../dist/utils/email/suggest.js';

const args = process.argv.slice(2);

if (args[0] === '--generate') {
  const count = parseInt(args[1] || '5', 10);
  console.log(`Generating ${count} domain suggestions via LLM...`);
  for (let i = 0; i < count; i++) {
    try {
      const name = await suggestDomainName('.com');
      console.log(`  ${i + 1}. ${name}`);
    } catch (e) {
      console.error(`  ${i + 1}. FAILED: ${e.message}`);
      break;
    }
  }
} else if (args.length === 0) {
  console.error('Usage:');
  console.error('  search_availability.mjs <domain1> [domain2] ...   — check specific domains');
  console.error('  search_availability.mjs --generate <count>       — LLM-suggest + check');
  process.exit(1);
} else {
  for (const d of args) {
    try {
      const r = await checkDomain(d);
      if (r.available && !r.premium) console.log(`AVAILABLE: ${d}`);
      else if (r.available) console.log(`PREMIUM:    ${d}`);
      else console.log(`TAKEN:      ${d}`);
    } catch (e) {
      console.error(`ERROR:      ${d} — ${e.message?.slice(0, 80)}`);
    }
  }
}
