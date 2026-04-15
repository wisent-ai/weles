import { WSession } from '../../dist/session/wsession.js';
import { execute } from '../../dist/agent/loop.js';
import { TRAJECTORIES } from '../run_all_export.mjs';

const t = TRAJECTORIES.find(t => t.name === 'github_follow');
if (!t) { console.error('Trajectory not found: github_follow'); process.exit(1); }
if (t.emailEnv) {
  process.env.SVC_EMAIL = process.env[t.emailEnv] || '';
  process.env.SVC_PASSWORD = process.env[t.passEnv] || '';
  if (!process.env.SVC_EMAIL) { console.log('SKIP — set ' + t.emailEnv); process.exit(0); }
}
const s = await WSession.start({ label: 'github_follow', proxy: process.env.PROXY_URL || undefined });
try {
  await s.goto(t.url);
  const result = await execute(s.page, `Open ${t.url}. ${t.goal}`, {
    envHints: t.emailEnv ? { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' } : {},
    flowName: 'github_follow',
  });
  console.log('PASS:', result.value);
} catch (e) {
  console.log('FAIL:', e.message?.slice(0, 200));
  process.exit(1);
} finally {
  await s.close();
}
