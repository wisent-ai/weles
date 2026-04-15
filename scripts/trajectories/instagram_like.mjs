import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';

const URL = 'https://www.instagram.com/wisent.ai/';
const GOAL = `Wait 3 seconds. If not logged in, give_up(reason="not logged in, inject cookies"). Click on the first post thumbnail. Wait 2 seconds. Click the heart/like button. done(value="liked").`;

if (!process.env.INSTAGRAM_EMAIL) { console.log('SKIP — set INSTAGRAM_EMAIL'); process.exit(0); }
process.env.SVC_EMAIL = process.env.INSTAGRAM_EMAIL;
process.env.SVC_PASSWORD = process.env.INSTAGRAM_PASSWORD;

const s = await WSession.start({ label: 'instagram_like', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(URL);
  const result = await execute(s, `Open ${URL}. ${GOAL}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'instagram_like',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
