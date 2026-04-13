import { AsyncNewBrowser } from '../dist/async_api.js';
import { execute } from '../dist/agent/loop.js';
import { writeFileSync } from 'node:fs';
import { TRAJECTORIES } from './run_all_export.mjs';

const filter = process.argv[2];

async function runOne(t) {
  console.log(`\n${'='.repeat(60)}\n[${t.name}] Starting...\n${'='.repeat(60)}`);
  if (t.emailEnv) {
    process.env.SVC_EMAIL = process.env[t.emailEnv] || '';
    process.env.SVC_PASSWORD = process.env[t.passEnv] || '';
    if (!process.env.SVC_EMAIL) {
      console.log(`[${t.name}] SKIP — no ${t.emailEnv} in env`);
      return { name: t.name, status: 'skip', reason: `missing ${t.emailEnv}` };
    }
  }
  let ctx;
  try {
    ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false });
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(t.url, { waitUntil: t.waitLoad ? 'load' : 'domcontentloaded' });
    await page.waitForTimeout(t.waitLoad ? 5000 : 3000);
    const result = await execute(page, `Open ${t.url}. ${t.goal}`, {
      envHints: t.emailEnv ? { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' } : {},
    });
    console.log(`[${t.name}] PASS: ${JSON.stringify(result.value).slice(0, 200)}`);
    return { name: t.name, status: 'pass', value: result.value };
  } catch (e) {
    console.log(`[${t.name}] FAIL: ${e.message.slice(0, 200)}`);
    return { name: t.name, status: 'fail', error: e.message.slice(0, 500) };
  } finally {
    try { if (ctx) await ctx.close(); } catch {}
  }
}

async function main() {
  const toRun = filter ? TRAJECTORIES.filter(t => t.name === filter || t.name.includes(filter)) : TRAJECTORIES;
  if (toRun.length === 0) { console.log(`No trajectory matching "${filter}"`); process.exit(1); }
  const results = [];
  for (const t of toRun) { results.push(await runOne(t)); }
  console.log(`\n${'='.repeat(60)}\nSUMMARY\n${'='.repeat(60)}`);
  for (const r of results) {
    const icon = r.status === 'pass' ? 'PASS' : r.status === 'skip' ? 'SKIP' : 'FAIL';
    console.log(`  ${icon} ${r.name}${r.value ? ': ' + JSON.stringify(r.value).slice(0,100) : ''}${r.error ? ': ' + r.error.slice(0,100) : ''}${r.reason ? ': ' + r.reason : ''}`);
  }
  writeFileSync('recordings/trajectory_results.json', JSON.stringify(results, null, 2));
  const p = results.filter(r => r.status === 'pass').length;
  const f = results.filter(r => r.status === 'fail').length;
  const s = results.filter(r => r.status === 'skip').length;
  console.log(`\n${p} passed, ${f} failed, ${s} skipped out of ${results.length}`);
  process.exit(f > 0 ? 1 : 0);
}
main();
