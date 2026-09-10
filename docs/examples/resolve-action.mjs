#!/usr/bin/env node
// Resolve a Weles action name to its trajectory script and show the env vars
// the spawned trajectory subprocess would receive. Uses the SAME compiled
// resolver the Stado runner and the HTTP API use (dist/worker/dispatch.js),
// so what this prints is exactly what a real dispatch computes.
//
// Usage: node docs/examples/resolve-action.mjs [action] [declaration]
//   node docs/examples/resolve-action.mjs generic_saved_task twitter.like
//   node docs/examples/resolve-action.mjs generic_keeper_task reddit.search
// Runs offline; params below are synthetic.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const { resolveTrajectory, paramsToEnv } = await import(`${repo}/dist/worker/dispatch.js`);
const { declaredObservations } = await import(`${repo}/dist/worker/observations.js`);

const action = process.argv[2] || 'generic_browser_task';
const declaration = process.argv[3] || '';
// A declared observation owns the origin and the dwell budget, so a
// submission naming an observation must not also carry a url or an objective:
// admission refuses that as two answers to what the run reads. What it does
// name is the origin's placeholders, and exactly those — read here from the
// declaration itself, which is what makes the example demonstrate the real
// contract rather than a guess at it.
const observing = action === 'generic_keeper_task' && declaration;
const sampleValues = { query: 'representation engineering', handle: 'wisent-ai', subreddit: 'MachineLearning' };
const origin = observing ? declaredObservations().get(declaration)?.origin ?? '' : '';
const sampleParams = observing
  ? {
    observation: declaration,
    ...Object.fromEntries([...origin.matchAll(/\{([a-z_]+)\}/g)].map(([, name]) => [name, sampleValues[name]])),
  }
  : {
    url: 'https://example.com/',
    objective: 'Read the page heading and report it back.',
    flow_name: 'docs_example',
    headless: true,
    ...(declaration ? { engagement: declaration } : {}),
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
    // an undeclared engagement or observation fails here — before a browser is
    // launched — with the sentence the caller receives.
    console.log(`refused at admission: ${error.message}`);
  }
}

// Contrast with an action nobody registered: same resolver, null result.
const unknown = 'nosuchplatform_nosuchverb';
console.log(`\ncontrol: resolveTrajectory('${unknown}') ->`, resolveTrajectory(unknown));

// And an interaction verb, which is no longer a verb: bookmark, comment, dm,
// follow, like, post, promote, star and the rest are declared engagements
// replayed by generic_saved_task, so the old per-site action name resolves to
// nothing at all. The benign-activity verbs went the same way: browse, dwell,
// notifications, profile_view and search are declared observations run by
// generic_keeper_task.
for (const removed of ['twitter_like', 'twitter_dwell', 'reddit_browse', 'github_search']) {
  console.log(`control: resolveTrajectory('${removed}') ->`, resolveTrajectory(removed));
}
