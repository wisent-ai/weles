import { WSession } from '../../../dist/session/wsession.js';

const URL = 'https://www.threads.net/login';
const MAX_RETRIES = 3;
const proxy = process.env.PROXY_URL || 'none';
const sleep = (s) => new Promise(r => setTimeout(r, s * 1000));

// TODO: Implement Threads registration flow
// Threads requires an existing Instagram account — it uses Instagram SSO
// Steps: navigate to threads.net, click "Log in with Instagram",
// enter Instagram credentials (or use saved cookies),
// complete Threads onboarding (profile, follow suggestions, etc.)
// Prerequisites: must have a working Instagram account first

async function signup(s) {
  const id = await s.generateIdentity('threads');
  console.log(`[threads] identity: ${id.username} / ${id.email}`);
  console.log('[threads] Threads registration not yet implemented (requires Instagram account)');
  throw new Error('not_implemented');
}

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Threads signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `threads_register_${attempt}`, proxy });
  try {
    const username = await signup(s);
    console.log(`PASS: ${username}`);
    await s.close();
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    await s.close().catch(() => {});
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
    await sleep(3);
  }
}
