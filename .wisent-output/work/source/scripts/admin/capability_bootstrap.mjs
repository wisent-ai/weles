// Bootstrap the proxy_capability_matrix by enqueueing one health-check
// trajectory per (provider, platform) cell. Each row carries a forced
// proxy_url_override so the test runs deterministically through that
// provider regardless of stored proxy. Outcomes flow back into the matrix
// via worker/poll.recordOutcome.
//
// Usage:  node scripts/admin/capability_bootstrap.mjs
import { resolveProxy } from '../../dist/proxy/config.js';

const DATABASE_URL = process.env.WELES_DATABASE_URL;
const DATABASE_TOKEN = process.env.WELES_DATABASE_TOKEN;
if (!DATABASE_URL || !DATABASE_TOKEN) { console.error('SUPABASE creds missing'); process.exit(1); }
const H = { apikey: DATABASE_TOKEN, Authorization: `Bearer ${DATABASE_TOKEN}`, 'Content-Type': 'application/json' };

const PROVIDERS = ['packetstream', 'pingproxies', 'iproyal', 'oxylabs', 'brightdata'];
const PLATFORMS = ['reddit', 'instagram', 'twitter', 'linkedin', 'tiktok', 'discord', 'producthunt'];
const PHOST = { reddit: 'www.reddit.com', instagram: 'www.instagram.com', twitter: 'x.com', linkedin: 'www.linkedin.com', tiktok: 'www.tiktok.com', discord: 'discord.com', producthunt: 'www.producthunt.com' };

// Pick one active account per platform to host the test run.
async function pickAccount(platform) {
  const r = await fetch(`${DATABASE_URL}/rest/v1/social_accounts?platform=eq.${platform}&is_active=eq.true&select=id,username&limit=1`, { headers: H });
  const rows = await r.json();
  return rows[0] ?? null;
}

const enqueued = []; const skipped = [];
for (const platform of PLATFORMS) {
  const acct = await pickAccount(platform);
  if (!acct) { skipped.push(`${platform}: no active account`); continue; }
  for (const provider of PROVIDERS) {
    process.stdout.write(`  [${provider} x ${platform}] resolving sticky session...`);
    let pw;
    try { pw = await resolveProxy(`residential ${provider} us`, PHOST[platform]); }
    catch (e) { console.log(` ERR: ${e.message?.slice(0,80)}`); skipped.push(`${provider}/${platform}: ${e.message?.slice(0,40)}`); continue; }
    if (!pw?.server) { console.log(' no proxy resolved'); skipped.push(`${provider}/${platform}: no proxy`); continue; }
    const u = new URL(pw.server);
    const proxy_url = `${u.protocol}//${encodeURIComponent(pw.username)}:${encodeURIComponent(pw.password)}@${u.hostname}:${u.port}`;
    const row = {
      account_id: acct.id, platform, action: `${platform}_health`, status: 'queued',
      scheduled_at: new Date().toISOString(),
      params: { proxy_url_override: proxy_url, test_batch: 'capability_bootstrap', test_provider: provider },
    };
    const ins = await fetch(`${DATABASE_URL}/rest/v1/account_action_logs`, { method: 'POST', headers: { ...H, Prefer: 'return=representation' }, body: JSON.stringify(row) });
    if (!ins.ok) { console.log(` ENQUEUE FAILED: ${ins.status}`); skipped.push(`${provider}/${platform}: enqueue ${ins.status}`); continue; }
    const created = await ins.json();
    console.log(` enqueued ${created[0].id.slice(0,8)} on ${acct.username}`);
    enqueued.push({ provider, platform, action_log_id: created[0].id, exit_ip: pw.exit_ip });
  }
}

console.log(`\nEnqueued: ${enqueued.length}`);
console.log(`Skipped:  ${skipped.length}`);
if (skipped.length) for (const s of skipped) console.log(`  - ${s}`);
