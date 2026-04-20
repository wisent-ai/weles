import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';

const URL = 'https://accounts.google.com/signup?continue=https%3A%2F%2Fwww.youtube.com%2F&flowName=GlifWebSignIn&flowEntry=SignUp';
const MAX_RETRIES = 3;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== YouTube/Google signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `youtube_register_${attempt}`, proxy: process.env.PROXY_URL || 'none' });
  try {
    const id = await s.generateIdentity('youtube');
    console.log(`[yt] identity: ${id.username} / ${id.email}`);

    const GOAL = [
      `Open ${URL}.`,
      `Fill first name "${id.firstName}". Fill last name "${id.lastName}". Click Next.`,
      `Fill birth month, day, year using ${id.birthMonth} ${id.birthDay} ${id.birthYear}. Select gender "Rather not say". Click Next.`,
      `When offered existing address options, click "Create your own Gmail address". Fill username "${id.username}". Click Next.`,
      `Fill password "${id.password}". Fill confirm "${id.password}". Click Next.`,
      `If a phone number page appears, click "Skip" if available. If not, use the phone provided by the assistant. Accept terms when prompted and click "I agree".`,
      `Wait for redirect to youtube.com or myaccount.google.com. done(value="registered").`,
    ].join(' ');

    const result = await execute(s, GOAL, {
      envHints: { FIRST: id.firstName, LAST: id.lastName, USER: id.username, EMAIL: id.email },
      flowName: 'youtube_register',
    });
    console.log(`[yt] ${result.value}`);
    await s.saveAccount('youtube', { username: id.username, email: id.email, password: id.password, status: 'verified' });
    console.log(`PASS: ${id.username}`);
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
  } finally {
    await s.close().catch(() => {});
  }
}
