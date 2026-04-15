import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://app.packetstream.io';
const GOAL = `Fill username/email with $SVC_EMAIL and password with $SVC_PASSWORD. Click Log In or Sign In. Wait for redirect. Read any balance or credit data. done(value=<data>).`;

if (!process.env.PACKETSTREAM_EMAIL) { console.log('SKIP — set PACKETSTREAM_EMAIL'); process.exit(0); }
process.env.SVC_EMAIL = process.env.PACKETSTREAM_EMAIL;
process.env.SVC_PASSWORD = process.env.PACKETSTREAM_PASSWORD;

const s = await WSession.start({ label: 'packetstream_balance', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'packetstream_balance',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
