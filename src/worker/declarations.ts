// The admission step, in one place.
//
// A capability family lands by replacing its verbs with a checked-in
// declaration and a primitive that consumes it, and every one of those
// declarations is resolved here — in
// ./params-to-env/account-and-task-admission.ts, before anything is
// spawned — so a submission naming something nobody declared is refused with
// an exact sentence instead of becoming a run that discovers the gap.
//
// Two families read a declaration today: ./engagements.ts for
// generic_saved_task and ./observations.ts for generic_keeper_task. Each new
// family adds its reader here; the admission module keeps calling one function.

import { applySavedTaskEnv } from './engagements.js';
import { applyKeeperTaskEnv } from './observations.js';

export function applyDeclaredEnv(
  params: Record<string, unknown>,
  trajPath: string,
  env: Record<string, string>,
): void {
  applySavedTaskEnv(params, trajPath, env);
  applyKeeperTaskEnv(params, trajPath, env);
}
