import { AsyncNewBrowser } from '../dist/async_api.js';
import { execute } from '../dist/agent/loop.js';

// Goal imported from scripts/run_all.mjs — run with:
//   node scripts/run_all.mjs discord_register
// This file wraps the same goal as a standalone test.

async function main() {
  const { default: { TRAJECTORIES } } = await import('../scripts/run_all_export.mjs');
  const t = TRAJECTORIES.find(t => t.name === 'discord_register');
  if (!t) { console.error('Trajectory not found: discord_register'); process.exit(1); }

  if (t.emailEnv) {
    process.env.SVC_EMAIL = process.env[t.emailEnv] || '';
    process.env.SVC_PASSWORD = process.env[t.passEnv] || '';
    if (!process.env.SVC_EMAIL) { console.log('SKIP — set ' + t.emailEnv); process.exit(0); }
  }

  const ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false });
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.goto(t.url, { waitUntil: t.waitLoad ? 'load' : 'domcontentloaded' });
    await page.waitForTimeout(t.waitLoad ? 5000 : 3000);
    const result = await execute(page, 'Open ' + t.url + '. ' + t.goal, {
      envHints: t.emailEnv ? { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' } : {},
    });
    console.log('Result:', result.value);
    process.exit(result.value ? 0 : 1);
  } finally { await ctx.close(); }
}
main().catch(e => { console.error('Error:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT 5min'); process.exit(2); }, 300000);
