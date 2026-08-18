#!/usr/bin/env node
// Provision a new inbound email domain end-to-end.
// Usage: node scripts/domains/provision.mjs <domain> [years]

import { provisionDomain } from '../../dist/utils/email/provision.js';

const [domain, yearsArg] = process.argv.slice(2);
if (!domain) { console.error('Usage: provision.mjs <domain> [years]'); process.exit(1); }
const years = yearsArg ? parseInt(yearsArg, 10) : 1;

try {
  const result = await provisionDomain(domain, { years });
  console.log(`\nDone. ${domain} → $${result.chargedUsd.toFixed(2)}, resend=${result.resendId}, verified=${result.verified}`);
  if (!result.verified) console.log('Domain is in rotator as pending — run manage.mjs verify <domain> once Resend confirms.');
  process.exit(result.verified ? 0 : 2);
} catch (e) {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
}
