// Test Oxylabs balance via WSession
import { WSession } from './dist/session/wsession.js';
import { execute } from './dist/agent/loop.js';
import { TRAJECTORIES } from './scripts/run_all_export.mjs';

const t = TRAJECTORIES.find(t => t.name === 'oxylabs_balance');
if (!t) { console.error('oxylabs_balance trajectory not found'); process.exit(1); }

process.env.SVC_EMAIL = process.env.OXYLABS_EMAIL || '';
process.env.SVC_PASSWORD = process.env.OXYLABS_PASSWORD || '';

const s = await WSession.start({ label: 'oxylabs_balance', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(t.url);
  const result = await execute(s.page, `Open ${t.url}. ${t.goal}`, {
    envHints: { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' },
    flowName: 'oxylabs_balance',
  });
  console.log('Result:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
} finally {
  await s.close();
}
