import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://discord.com/login';
const GOAL = `Fill username/email with $SVC_EMAIL and password with $SVC_PASSWORD. Click Log In or Sign In. Wait for redirect. done(value="logged in").`;

if (!process.env.DISCORD_EMAIL) { console.log('SKIP — set DISCORD_EMAIL'); process.exit(0); }
process.env.SVC_EMAIL = process.env.DISCORD_EMAIL;
process.env.SVC_PASSWORD = process.env.DISCORD_PASSWORD;

const s = await WSession.start({ label: 'discord_login', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  await s.wait(3);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'discord_login',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
