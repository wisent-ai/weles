#!/usr/bin/env node
// Resolve a Weles action name to its trajectory script and show the env vars
// the spawned trajectory subprocess would receive. Uses the SAME compiled
// resolver the Stado runner and the HTTP API use (dist/worker/dispatch.js),
// so what this prints is exactly what a real dispatch computes.
//
// Usage: node docs/examples/resolve-action.mjs [action] [engagement]
// Runs offline; params below are synthetic.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { resolveTrajectory, paramsToEnv } = await import(`${repo}/dist/worker/dispatch.js`);

const action = process.argv[2] || 'generic_browser_task';
const engagement = process.argv[3] || '';
const sampleParams = {
  url: 'https://example.com/',
  objective: 'Read the page heading and report it back.',
  flow_name: 'docs_example',
  headless: true,
  ...(engagement ? { engagement } : {}),
};

console.log(`action: ${action}`);
const trajectory = resolveTrajectory(action);
if (!trajectory) {
  // resolveTrajectory returns null for any action with no branch in ROUTES
  // (or with no <platform>_<verb> underscore at all). Null means: not
  // dispatchable — the Stado runner throws `no Weles trajectory for <action>`.
  console.log('trajectory: null (not dispatchable; the Stado runner would refuse it)');
} else {
  console.log(`trajectory: ${trajectory}`);
  console.log('env from paramsToEnv(sampleParams, action, trajectory):');
  try {
    console.log(JSON.stringify(paramsToEnv(sampleParams, action, trajectory), null, 2));
  } catch (error) {
    // Admission. paramsToEnv is where a submission is accepted or refused, so
    // an undeclared engagement fails here — before a browser is launched —
    // with the sentence the caller receives.
    console.log(`refused at admission: ${error.message}`);
  }
}

// Contrast with an action nobody registered: same resolver, null result.
const unknown = 'nosuchplatform_nosuchverb';
console.log(`\ncontrol: resolveTrajectory('${unknown}') ->`, resolveTrajectory(unknown));

// And an interaction verb, which is no longer a verb: bookmark, comment, dm,
// follow, like, post, promote, star and the rest are declared engagements
// replayed by generic_saved_task, so the old per-site action name resolves to
// nothing at all.
const removed = 'twitter_like';
console.log(`control: resolveTrajectory('${removed}') ->`, resolveTrajectory(removed));
