#!/usr/bin/env node
// Build the exact Stado job a queued Weles action becomes — WITHOUT submitting
// it. Mirrors scripts/_shared/stado-action-queue.mjs (payload construction)
// and then re-validates the payload with the same checks
// scripts/worker/stado-action-runner.mjs applies before spawning anything,
// so the refusal strings you see here are the real ones.
//
// Usage: node docs/examples/build-stado-job.mjs [action]
// Runs offline; nothing is submitted and no stado binary is needed.

// Same regexes as stado-action-queue.mjs / stado-action-runner.mjs.
const SAFE_ACTION = /^[a-z][a-z0-9_]{0,127}$/;
const SAFE_ACCOUNT_ITEM = /^weles-[a-z0-9][a-z0-9-]{0,126}$/;

const action = process.argv[2] || 'generic_browser_task';
const accountItem = 'weles-docs-example-account';
const params = { url: 'https://example.com/', objective: 'Report the page heading.' };

// --- enqueue side (stado-action-queue.mjs) --------------------------------
if (!SAFE_ACTION.test(String(action))) throw new Error(`invalid Weles action: ${action}`);
if (accountItem && !SAFE_ACCOUNT_ITEM.test(String(accountItem))) {
  throw new Error('accountItem must be an exact Weles Skarbiec item id');
}
const payload = Buffer.from(JSON.stringify({ action, accountItem, params }), 'utf8').toString('base64url');
console.log('payload (base64url):', payload);
console.log('\nthe queue helper would submit exactly:');
console.log(`  stado submit "node scripts/worker/stado-action-runner.mjs ${payload}" --priority 0`);

// --- runner side (stado-action-runner.mjs) --------------------------------
// Decode the payload back and run the runner's own gate, to prove the two
// ends agree before any subprocess is spawned.
function runnerGate(encoded) {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('one base64url action payload is required');
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  if (!/^[a-z][a-z0-9_]{0,127}$/.test(String(decoded.action || ''))) throw new Error('invalid Weles action');
  if (decoded.accountItem && !/^weles-[a-z0-9][a-z0-9-]{0,126}$/.test(String(decoded.accountItem))) {
    throw new Error('invalid Weles account item');
  }
  if (!decoded.params || Array.isArray(decoded.params) || typeof decoded.params !== 'object') {
    throw new Error('invalid Weles action params');
  }
  return decoded;
}

console.log('\nrunner-side re-validation of the same payload:');
console.log(' ', JSON.stringify(runnerGate(payload)));

// A payload whose action does not match ^[a-z][a-z0-9_]{0,127}$ is refused by
// the runner before dispatch. Show the exact refusal string.
const bad = Buffer.from(JSON.stringify({ action: '9Bad-Action', accountItem: '', params: {} }), 'utf8').toString('base64url');
console.log('\nrunner-side validation of a payload with action "9Bad-Action":');
try {
  runnerGate(bad);
} catch (error) {
  console.log(`  refused: ${error.message}`);
}
