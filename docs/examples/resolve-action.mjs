#!/usr/bin/env node
// Resolve a Weles action name to its trajectory script and show the env vars
// the spawned trajectory subprocess would receive. Uses the SAME compiled
// resolver the Stado runner and the HTTP API use (dist/worker/dispatch.js),
// so what this prints is exactly what a real dispatch computes.
//
// Usage: node docs/examples/resolve-action.mjs [action]
// Runs offline; params below are synthetic.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { resolveTrajectory, paramsToEnv } = await import(`${repo}/dist/worker/dispatch.js`);

const action = process.argv[2] || 'generic_browser_task';
const sampleParams = {
  url: 'https://example.com/',
  objective: 'Read the page heading and report it back.',
  flow_name: 'docs_example',
  headless: true,
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
  console.log(JSON.stringify(paramsToEnv(sampleParams, action, trajectory), null, 2));
}

// Contrast with an action nobody registered: same resolver, null result.
const unknown = 'nosuchplatform_nosuchverb';
console.log(`\ncontrol: resolveTrajectory('${unknown}') ->`, resolveTrajectory(unknown));
