// Sweep Oxylabs Dedicated ISP ports 8001-8005 through the LinkedIn A/B harness.
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ports = [8001, 8002, 8003, 8004, 8005];
const results = [];

for (const port of ports) {
  console.log(`\n=== sweeping dedicated ISP port ${port} ===`);
  const env = { ...process.env, OXYLABS_DEDICATED_ISP_PORT: String(port), AB_HEADLESS: '1', LINKEDIN_REGISTER_PROXY: 'isp oxylabs us' };
  const res = spawnSync(process.execPath, ['--env-file=.env', 'scripts/debug/linkedin_ab_diagnosis.mjs'], { env, cwd: process.cwd(), encoding: 'utf8', timeout: 240000 });
  console.log(res.stdout.slice(-800));
  if (res.stderr) console.log(res.stderr.slice(-400));

  // Find the latest report in recordings/linkedin_ab_*
  const recordingsDir = join(process.cwd(), 'recordings');
  const dirs = readdirSync(recordingsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name.startsWith('linkedin_ab_'))
    .map(d => d.name)
    .sort();
  const latestDir = dirs[dirs.length - 1];
  let report = null;
  try {
    const reportPath = join(recordingsDir, latestDir, 'linkedin_ab_diagnosis', `${latestDir}.json`);
    report = JSON.parse(readFileSync(reportPath, 'utf8'));
  } catch {}
  results.push({
    port,
    exitIp: report?.proxy?.exitIp || null,
    chromeOutcome: report?.chrome?.outcome?.outcome || 'unknown',
    welesOutcome: report?.weles?.outcome?.outcome || 'unknown',
    verdict: report?.verdict?.verdict || 'unknown',
  });
}

console.log('\n=== sweep summary ===');
for (const r of results) {
  console.log(`port=${r.port} exit_ip=${r.exitIp} chrome=${r.chromeOutcome} weles=${r.welesOutcome} verdict=${r.verdict}`);
}
