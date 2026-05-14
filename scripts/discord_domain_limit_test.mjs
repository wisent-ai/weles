import { execSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAX_ACCOUNTS = 20;
const BAN_CHECK_WAIT_MS = 180_000; // 3 minutes

async function checkBan(email) {
  const r = await fetch('https://api.resend.com/emails/receiving?limit=10', {
    headers: { Authorization: `Bearer ${process.env.RESEND_RECEIVING_API_KEY}` },
  });
  const d = await r.json();
  return d.data?.find(e =>
    (e.to || []).some(t => (typeof t === 'string' ? t : t.email) === email) &&
    (e.subject?.includes('Disabled') || e.subject?.includes('Suspicious'))
  );
}

// Count existing alive accounts on the current domain
let count = 0;
for (let i = 0; i < MAX_ACCOUNTS; i++) {
  console.log(`\n=== Account ${count + 1} ===`);
  
  try {
    const out = execSync(
      `PROXY_URL="http://127.0.0.1:9001" CAPTCHA_PROXY_URL="http://34.57.218.215:19002" DISCORD_HARDCODED=1 node --env-file=.env scripts/trajectories/discord_register.mjs`,
      { cwd: __dirname + '/..', env: process.env, stdio: 'pipe', timeout: 600_000 }
    ).toString();
    
    const passMatch = out.match(/PASS: (\S+)/);
    if (!passMatch) { console.log('Registration did not PASS'); console.log(out.slice(-300)); continue; }
    
    const username = passMatch[1];
    const domainMatch = out.match(/domain.*?(\S+\.com)/i);
    const domain = domainMatch?.[1] || 'unknown';
    count++;
    console.log(`Registered: ${username}@${domain} (${count} total)`);
    
    // Wait and check for ban
    console.log(`Waiting ${BAN_CHECK_WAIT_MS / 1000}s for ban check...`);
    await new Promise(r => setTimeout(r, BAN_CHECK_WAIT_MS));  // allow-raw-playwright: review — context-dependent timer
    
    // Check for ban email
    const emails = ['@dashnet102.com', '@mailnova419.com', '@mailwisent.com', '@wisentmedia.com'];
    let email = null;
    for (const suffix of emails) {
      const candidate = username + suffix;
      const ban = await checkBan(candidate);
      if (ban) {
        console.log(`BANNED at count ${count}: ${ban.subject} (${candidate})`);
        console.log(`\n>>> RESULT: ${count - 1} accounts survived, account ${count} was banned <<<`);
        process.exit(0);
      }
      // Check if this is the right email
      const r2 = await fetch('https://api.resend.com/emails/receiving?limit=5', {
        headers: { Authorization: `Bearer ${process.env.RESEND_RECEIVING_API_KEY}` },
      });
      const d2 = await r2.json();
      if (d2.data?.some(e => (e.to || []).some(t => (typeof t === 'string' ? t : t.email) === candidate))) {
        email = candidate;
      }
    }
    
    console.log(`Account ${count} alive ✓ (${email || username})`);
    
  } catch (e) {
    console.log(`Registration failed: ${e.message?.slice(0, 100)}`);
  }
}
console.log(`\nCompleted ${count} accounts without ban`);
