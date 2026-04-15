// Thin runner: executes standalone trajectory files by name
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2];

if (!filter) {
  console.log('Usage: node scripts/run_all.mjs <trajectory_name|all>');
  console.log('Example: node scripts/run_all.mjs reddit_upvote');
  console.log('Example: node scripts/run_all.mjs all');
  process.exit(1);
}

const trajDir = join(__dirname, 'trajectories');
const allFiles = (await import('node:fs')).readdirSync(trajDir).filter(f => f.endsWith('.mjs')).map(f => f.replace('.mjs', ''));

const toRun = filter === 'all' ? allFiles : allFiles.filter(n => n === filter || n.includes(filter));
if (toRun.length === 0) { console.log(`No trajectory matching "${filter}"`); process.exit(1); }

const results = [];
for (const name of toRun) {
  const file = join(trajDir, `${name}.mjs`);
  console.log(`\n${'='.repeat(60)}\n[${name}]\n${'='.repeat(60)}`);
  try {
    execSync(`node ${file}`, { stdio: 'inherit', env: process.env });
    results.push({ name, status: 'pass' });
  } catch {
    results.push({ name, status: 'fail' });
  }
}

console.log(`\n${'='.repeat(60)}\nSUMMARY\n${'='.repeat(60)}`);
for (const r of results) console.log(`  ${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.name}`);
const p = results.filter(r => r.status === 'pass').length;
const f = results.filter(r => r.status === 'fail').length;
console.log(`\n${p} passed, ${f} failed out of ${results.length}`);
process.exit(f > 0 ? 1 : 0);
