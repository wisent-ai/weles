// Generate individual test files for each trajectory from run_all.mjs
// Also adds justifications to file_justifications.json

import { readFileSync, writeFileSync } from 'node:fs';

const TRAJECTORIES = [
  'anticaptcha_balance', 'brightdata_balance', 'capmonster_balance',
  'discord_login', 'discord_register', 'github_follow', 'github_login',
  'github_star', 'instagram_follow', 'instagram_like', 'instagram_login',
  'instagram_register', 'linkedin_login', 'oxylabs_balance',
  'packetstream_balance', 'reddit_comment', 'reddit_login',
  'reddit_register', 'reddit_upvote', 'tiktok_follow', 'tiktok_like',
  'tiktok_login', 'tiktok_register', 'twitter_dm', 'twitter_follow',
  'twitter_like', 'twitter_login', 'twitter_register',
];

const TEMPLATE = (name) => `import { AsyncNewBrowser } from '../dist/async_api.js';
import { execute } from '../dist/agent/loop.js';
import { humanIdlePause } from '../dist/human/mouse.js';

// Goal imported from scripts/run_all.mjs — run with:
//   node scripts/run_all.mjs ${name}
// This file wraps the same goal as a standalone test.

async function main() {
  const { default: { TRAJECTORIES } } = await import('../scripts/run_all_export.mjs');
  const t = TRAJECTORIES.find(t => t.name === '${name}');
  if (!t) { console.error('Trajectory not found: ${name}'); process.exit(1); }

  if (t.emailEnv) {
    process.env.SVC_EMAIL = process.env[t.emailEnv] || '';
    process.env.SVC_PASSWORD = process.env[t.passEnv] || '';
    if (!process.env.SVC_EMAIL) { console.log('SKIP — set ' + t.emailEnv); process.exit(0); }
  }

  const ctx = await AsyncNewBrowser({ os: 'macos', browser: 'chromium', headless: false });
  const page = ctx.pages()[0] || await ctx.newPage();
  try {
    await page.goto(t.url, { waitUntil: t.waitLoad ? 'load' : 'domcontentloaded' });
    await humanIdlePause();
    const result = await execute(page, 'Open ' + t.url + '. ' + t.goal, {
      envHints: t.emailEnv ? { SVC_EMAIL: process.env.SVC_EMAIL, SVC_PASSWORD: '***' } : {},
    });
    console.log('Result:', result.value);
    process.exit(result.value ? 0 : 1);
  } finally { await ctx.close(); }
}
main().catch(e => { console.error('Error:', e.message); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT 5min'); process.exit(2); }, 300000);
`;

// Add justifications
const justPath = '/Users/lukaszbartoszcze/.claude/file_justifications.json';
const just = JSON.parse(readFileSync(justPath, 'utf-8'));
for (const name of TRAJECTORIES) {
  const path = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles/tests/' + name.replace(/_/g, '-') + '.test.mjs';
  if (!just[path]) {
    just[path] = {
      justification: `Standalone integration test for the ${name} trajectory. Imports goal definition from run_all_export.mjs, launches AsyncNewBrowser with custom Chromium binary, navigates to the target URL, runs the tool-use loop with the trajectory-specific goal, and reports pass or fail. Each trajectory has its own test file so it can be run independently. Wraps the same goal as node scripts/run_all.mjs ${name}. Approximately 30 lines.`
    };
  }
}
writeFileSync(justPath, JSON.stringify(just, null, 2));
console.log('Added justifications for', TRAJECTORIES.length, 'test files');

// Generate test files
let generated = 0;
for (const name of TRAJECTORIES) {
  const path = 'tests/' + name.replace(/_/g, '-') + '.test.mjs';
  writeFileSync(path, TEMPLATE(name));
  generated++;
}
console.log('Generated', generated, 'test files');
