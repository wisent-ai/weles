import { getServiceLogin } from '../../dist/utils/credentials.js';
import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://app.packetstream.io';
const GOAL = `Fill username/email with $SVC_EMAIL and password with $SVC_PASSWORD. Click Log In or Sign In. Wait for redirect. Read any balance or credit data. done(value=<data>).`;

const login = await getServiceLogin('PacketStream');
if (!login) { console.log('FAIL: no PacketStream credentials in DB'); process.exit(1); }
process.env.SVC_EMAIL = login.email;
process.env.SVC_PASSWORD = login.password;
console.log(`[trajectory] Using service login: ${login.email}`);

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
