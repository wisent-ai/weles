// One-shot: enqueue a retry row for every failed action from a previous test
// batch, with action-appropriate params so the trajectory has the prerequisites
// it needs. Skips rows whose previous ban_signal was an environmental block
// (those are correct trajectory behavior, not bugs).
import { readFileSync } from 'node:fs';

const url = process.env.WELES_DATABASE_URL;
const key = process.env.WELES_DATABASE_TOKEN;
const newBatch = process.env.NEW_BATCH;
const failedPath = process.env.FAILED_PATH ?? '/tmp/failed_to_rerun.json';
const productId = process.env.PRODUCT_ID ?? '61c52cc5-dd85-45cb-9ad2-b34c13b71936';

if (!url || !key || !newBatch) { console.log('missing env: WELES_DATABASE_URL, WELES_DATABASE_TOKEN, NEW_BATCH'); process.exit(Number('1')); }

const rows = JSON.parse(readFileSync(failedPath, 'utf8'));
const APPLE_PASSWORD_SUBMIT_ACTIONS = new Set([
  'apple_login',
  'apple_ads_api_setup_probe',
]);
let ok = 0, skipped = 0, skippedOrphan = 0, skippedOwnerAction = 0;
for (const r of rows) {
  if (!r.account_id) { skippedOrphan++; continue; }
  const a = r.action;
  if (APPLE_PASSWORD_SUBMIT_ACTIONS.has(a)) {
    skippedOwnerAction++;
    console.log(`OWNER_ACTION_REQUIRED ${a} account_id=${r.account_id}; retry not enqueued`);
    continue;
  }
  const sig = r.result?.ban_signal?.signal;
  if (sig && /shadowbanned|suspended|ip_blocked|checkpoint|reset_failed/.test(sig)) { skipped++; continue; }
  const params = { test_batch: newBatch };
  if (a === 'reddit_submit' || a === 'reddit_submit_promote') params.subreddit = 'test';
  // octocat/Hello-World is read-only; commit/open_issue 403 there. Default to a
  // sandbox repo owned by one of our github accounts (reggiestreich5124).
  // Override with GH_REPO/GH_ISSUE env vars if you point at a different one.
  const ghRepo = process.env.GH_REPO ?? 'https://github.com/reggiestreich5124/sandbox-e0cc44';
  const ghIssue = process.env.GH_ISSUE ?? `${ghRepo}/issues/1`;
  if (a === 'github_open_issue') params.repo_url = ghRepo;
  if (a === 'github_commit') params.repo_url = ghRepo;
  if (a === 'github_organic_issue_comment') params.issue_url = ghIssue;
  if (a === 'twitter_follow') params.target_user = 'github';
  if (a === 'instagram_follow') params.target_user = 'natgeo';
  if (a === 'reddit_follow') params.target_user = 'spez';
  if (a === 'tiktok_follow') params.target_user = 'tiktok';
  if (a === 'linkedin_connect') params.target_url = 'https://www.linkedin.com/in/satyanadella/';
  if (a.endsWith('_promote') || a.endsWith('_post_promote') || a.endsWith('_submit_promote')) params.product_id = productId;
  let accountId = r.account_id;
  if (a.startsWith('github_') && process.env.GH_OVERRIDE) accountId = process.env.GH_OVERRIDE;
  const platform = a.split('_')[0];
  const body = JSON.stringify({ account_id: accountId, action: a, platform, status: 'queued', params });
  const res = await fetch(url + '/rest/v1/account_action_logs', { method: 'POST', headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body });
  if (res.ok || res.status === 201) ok++;
  else console.log('FAIL', a, res.status);
}
console.log(`enqueued=${ok} skipped_envblock=${skipped} skipped_orphan=${skippedOrphan} skipped_owner_action=${skippedOwnerAction}`);
