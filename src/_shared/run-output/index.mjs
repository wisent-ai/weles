// Where a Weles run writes what it produces: screenshots and instrumentation
// dumps, per-service diagnostics, and the credentials a purchase trajectory
// scrapes on its way through a dashboard.
//
// Twenty-one call sites used to spell that path relative to the process
// working directory — `.work/keeper`, `.work/google-ads-keyword-planner`,
// `.work/inst` — which put run output inside the checkout and is how
// `weles/.work` reached 13 GB there. The operator's rule is one checkout per
// repository with nothing of ours written beside the code, so the root is the
// product's own state directory, next to the `~/.weles` cache
// `src/agent/tasks.ts` already uses.
//
// `WELES_RUN_OUTPUT_DIR` moves the whole root, which is what a test or a
// second machine needs; it must be absolute, because a relative value would
// land wherever the trajectory happened to be started from and that is the
// defect this module exists to remove.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const ROOT_VARIABLE = 'WELES_RUN_OUTPUT_DIR';

export function runOutputRoot() {
  const configured = process.env[ROOT_VARIABLE]?.trim();
  const root = configured && configured.length > 0 ? configured : join(homedir(), '.weles', 'runs');
  if (!isAbsolute(root)) {
    throw new Error(`${ROOT_VARIABLE} must be an absolute path, got ${root}`);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

/// One path below the run-output root. The root is created; a caller that
/// needs the intermediate directories creates them, exactly as it did when it
/// held the literal itself.
export function runOutputPath(...parts) {
  return join(runOutputRoot(), ...parts);
}
