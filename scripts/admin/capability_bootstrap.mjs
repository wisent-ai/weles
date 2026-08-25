// Submit one health-check trajectory per (provider, platform) cell through
// Stado. Proxy credentials resolve only inside the selected Weles worker.
import {
  enqueueWelesAction,
} from '../_shared/stado-action-queue.mjs';
import {
  listAccounts,
} from '../trajectories/_shared/skarbiec_accounts.mjs';


const PROVIDERS = ['packetstream', 'pingproxies', 'iproyal', 'oxylabs', 'brightdata'];
const PLATFORMS = ['reddit', 'instagram', 'twitter', 'linkedin', 'tiktok', 'discord', 'producthunt'];

function pickAccount(platform) {
  return listAccounts(platform)[0] ?? null;
}

const enqueued = []; const skipped = [];
for (const platform of PLATFORMS) {
  const acct = await pickAccount(platform);
  if (!acct) { skipped.push(`${platform}: no active account`); continue; }
  for (const provider of PROVIDERS) {
    process.stdout.write(`  [${provider} x ${platform}] submitting...`);
    try {
      const jobId = enqueueWelesAction({
        action: `${platform}_health`,
        accountItem: acct.id,
        params: {
          proxy_filter: `residential ${provider} us`,
          test_batch: 'capability_bootstrap',
          test_provider: provider,
        },
      });
      console.log(` submitted ${jobId} on ${acct.username}`);
      enqueued.push({ provider, platform, job_id: jobId });
    } catch (error) {
      console.log(` FAILED: ${error.message?.slice(0, 120)}`);
      skipped.push(`${provider}/${platform}: ${error.message?.slice(0, 80)}`);
    }
  }
}

console.log(`\nEnqueued: ${enqueued.length}`);
console.log(`Skipped:  ${skipped.length}`);
if (skipped.length) for (const s of skipped) console.log(`  - ${s}`);
