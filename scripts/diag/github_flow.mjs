#!/usr/bin/env node
/**
 * Single-account diagnostic: register → login → star → verify public.
 *
 * Runs on the local Mac using the patched weles Chromium. Captures enough
 * evidence at each step to localize where (if anywhere) GitHub decides to
 * flag the account.
 *
 * Usage:
 *   TARGET_REPO=wisent-ai/wisent node scripts/diag/github_flow.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const TARGET_REPO = process.env.TARGET_REPO || 'wisent-ai/wisent';
const ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles';
const ENV_PATH = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/content-platform/.env.local';
const CHROMIUM_PATH = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/chromium-build/src/out/Weles/Chromium.app/Contents/MacOS/Chromium';

if (!existsSync(CHROMIUM_PATH)) {
  console.error(`[FATAL] patched Chromium not found at ${CHROMIUM_PATH}`);
  process.exit(1);
}

function loadEnv(path) {
  const env = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    v = v.replace(/\\n/g, '');
    env[m[1]] = v;
  }
  return env;
}

const fileEnv = loadEnv(ENV_PATH);
const sub = (k) => fileEnv[k] ?? process.env[k] ?? '';
const SUPABASE_URL = sub('NEXT_PUBLIC_SUPABASE_URL');
const SVC_KEY = sub('SUPABASE_SERVICE_ROLE_KEY');
if (!SUPABASE_URL || !SVC_KEY) { console.error('[FATAL] missing Supabase env'); process.exit(1); }

const childEnv = {
  ...process.env,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY: SVC_KEY,
  RESEND_API_KEY: sub('RESEND_API_KEY'),
  RESEND_RECEIVING_API_KEY: sub('RESEND_RECEIVING_API_KEY'),
  CHROMIUM_PATH,
  PACKETSTREAM_USERNAME: sub('PACKETSTREAM_USERNAME'),
  PACKETSTREAM_PASSWORD: sub('PACKETSTREAM_PASSWORD'),
  OXYLABS_USERNAME: sub('OXYLABS_USERNAME'),
  OXYLABS_PASSWORD: sub('OXYLABS_PASSWORD'),
  OXYLABS_MOBILE_USERNAME: sub('OXYLABS_MOBILE_USERNAME'),
  OXYLABS_MOBILE_PASSWORD: sub('OXYLABS_MOBILE_PASSWORD'),
  ANTICAPTCHA_API_KEY: sub('ANTICAPTCHA_API_KEY'),
  CAPSOLVER_API_KEY: sub('CAPSOLVER_API_KEY'),
  CAPMONSTERCLOUD_API_KEY: sub('CAPMONSTERCLOUD_API_KEY'),
  TWOCAPTCHA_API_KEY: sub('TWOCAPTCHA_API_KEY'),
  SADCAPTCHA_API_KEY: sub('SADCAPTCHA_API_KEY'),
};

function section(title) { console.log(`\n${'='.repeat(72)}\n>>> ${title}\n${'='.repeat(72)}`); }

async function gh(path) {
  const r = await fetch(`https://api.github.com${path}`, { headers: { 'User-Agent': 'wisent-diag' } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

async function verifyAccount(username) {
  const u = await gh(`/users/${username}`);
  if (u.status === 200) {
    console.log(`  profile: public, created_at=${u.body.created_at}, followers=${u.body.followers}, public_repos=${u.body.public_repos}`);
    return { publiclyVisible: true, profile: u.body };
  }
  console.log(`  profile: API ${u.status} — account may be suspended or not indexed yet`);
  return { publiclyVisible: false, profile: null };
}

async function verifyStar(username, repo) {
  const [owner, name] = repo.split('/');
  const userStarred = await gh(`/users/${username}/starred?per_page=100`);
  const userSide = userStarred.status === 200 && (userStarred.body ?? []).some((r) => r.full_name === repo);
  const repoData = await gh(`/repos/${owner}/${name}`);
  const count = repoData.body?.stargazers_count ?? null;
  let publicSide = false;
  for (let page = 1; page <= 6; page++) {
    const sg = await gh(`/repos/${owner}/${name}/stargazers?per_page=100&page=${page}`);
    if (sg.status !== 200 || !Array.isArray(sg.body) || sg.body.length === 0) break;
    if (sg.body.some((s) => s.login === username)) { publicSide = true; break; }
  }
  console.log(`  repo ${repo} stargazers_count=${count}`);
  console.log(`  ${username}'s /starred includes ${repo}? ${userStarred.status === 200 ? (userSide ? 'YES' : 'no') : `API ${userStarred.status}`}`);
  console.log(`  ${username} appears in /repos/${repo}/stargazers public list? ${publicSide ? 'YES — real public star' : 'no — shadow-filtered or not landed'}`);
  return { userSide, publicSide };
}

async function fetchNewestAccount() {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/social_accounts?platform=eq.github&select=id,username,metadata,created_at&order=created_at.desc&limit=1`, {
    headers: { apikey: SVC_KEY, Authorization: `Bearer ${SVC_KEY}` },
  });
  return (await r.json())[0];
}

function run(script, extraEnv = {}) {
  console.log(`\n$ node ${script}`);
  const t0 = Date.now();
  const r = spawnSync('node', [script], { cwd: ROOT, env: { ...childEnv, ...extraEnv }, stdio: 'inherit' });
  console.log(`[exit=${r.status} elapsed_ms=${Date.now() - t0}]`);
  return r.status === 0;
}

(async () => {
  section('0. preflight');
  console.log(`CHROMIUM_PATH=${CHROMIUM_PATH}`);
  console.log(`SUPABASE_URL=${SUPABASE_URL}`);
  console.log(`TARGET_REPO=${TARGET_REPO}`);
  const baseline = await gh(`/repos/${TARGET_REPO}`);
  const baselineCount = baseline.body?.stargazers_count ?? null;
  console.log(`baseline ${TARGET_REPO} stargazers=${baselineCount}`);

  section('1. register (github/register.mjs)');
  const regOk = run('scripts/trajectories/github/register.mjs');
  if (!regOk) { console.log('\n[FATAL] register failed — aborting'); process.exit(1); }

  section('2. post-register state');
  const acct = await fetchNewestAccount();
  console.log(`new account: username=${acct.username} email=${acct.metadata?.email} created_at=${acct.created_at}`);
  console.log(`metadata keys: ${Object.keys(acct.metadata ?? {}).join(', ')}`);
  const pub1 = await verifyAccount(acct.username);

  section('3. login (github_login.mjs)');
  const loginOk = run('scripts/trajectories/github_login.mjs', { ACCOUNT_ID: acct.id });
  console.log(`login ${loginOk ? 'PASS' : 'FAIL'}`);

  section('4. post-login state');
  const pub2 = await verifyAccount(acct.username);

  section('5. star (github/star/run.mjs)');
  const starOk = run('scripts/trajectories/github/star/run.mjs', { ACCOUNT_ID: acct.id, REPO_URL: `https://github.com/${TARGET_REPO}` });
  console.log(`star trajectory ${starOk ? 'PASS' : 'FAIL'}`);

  section('6. ground-truth the star');
  const result = await verifyStar(acct.username, TARGET_REPO);

  section('7. summary');
  const afterCount = (await gh(`/repos/${TARGET_REPO}`)).body?.stargazers_count ?? null;
  console.log(`baseline count: ${baselineCount}`);
  console.log(`after-star count: ${afterCount}`);
  console.log(`count delta: ${afterCount !== null && baselineCount !== null ? afterCount - baselineCount : 'unknown'}`);
  console.log(`user-side star recorded: ${result.userSide ? 'YES' : 'no'}`);
  console.log(`public-side star listed: ${result.publicSide ? 'YES' : 'no'}`);
  console.log(`account profile publicly visible: pre=${pub1.publiclyVisible} post=${pub2.publiclyVisible}`);
  if (result.userSide && !result.publicSide) {
    console.log(`\n→ DIAGNOSIS: shadow-filtered. Account can star on its own profile but GitHub filters it from public lists. The account was flagged as abusive AT OR AFTER signup.`);
  } else if (result.userSide && result.publicSide) {
    console.log(`\n→ DIAGNOSIS: real public star. The patched Chromium + fresh account + local IP produces a publicly-counting conversion.`);
  } else if (!result.userSide) {
    console.log(`\n→ DIAGNOSIS: star never recorded even on user side. Session may be invalid or Star form submit never hit server.`);
  }
})();
