import { WSession } from '../../../dist/session/wsession.js';
import { execute } from '../../../dist/agent/loop.js';

const URL = 'https://accounts.snapchat.com/accounts/signup';
const MAX_RETRIES = 3;

for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
  console.log(`\n=== Snapchat signup attempt ${attempt}/${MAX_RETRIES} ===`);
  const s = await WSession.start({ label: `snapchat_register_${attempt}`, proxy: process.env.PROXY_URL || 'none' });
  try {
    const id = await s.generateIdentity('snapchat');
    console.log(`[sc] identity: ${id.username} / ${id.email}`);

    const GOAL = [
      `Open ${URL}.`,
      `Fill first name "${id.firstName}". Fill last name "${id.lastName}". Click Sign Up / Continue.`,
      `Fill the birthday: month ${id.birthMonth}, day ${id.birthDay}, year ${id.birthYear}. Click Continue.`,
      `Fill username "${id.username}". Click Continue.`,
      `Fill password "${id.password}". Click Continue.`,
      `If asked for a phone number, enter the SMS number provided by the assistant. When prompted for verification code, read it from the SMS inbox and fill.`,
      `If asked for an email instead of phone, fill "${id.email}" and poll Resend for the verification code.`,
      `Accept terms when prompted. Wait for redirect to accounts.snapchat.com or web.snapchat.com. done(value="registered").`,
    ].join(' ');

    const result = await execute(s, GOAL, {
      envHints: { FIRST: id.firstName, LAST: id.lastName, USER: id.username, EMAIL: id.email },
      flowName: 'snapchat_register',
    });
    console.log(`[sc] ${result.value}`);
    await s.saveAccount('snapchat', { username: id.username, email: id.email, password: id.password, status: 'verified' });
    console.log(`PASS: ${id.username}`);
    process.exit(0);
  } catch (e) {
    console.log(`FAIL (attempt ${attempt}): ${e.message?.slice(0, 200)}`);
    if (attempt === MAX_RETRIES) { console.log('All attempts exhausted'); process.exit(1); }
  } finally {
    await s.close().catch(() => {});
  }
}
