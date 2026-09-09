// Params → env for the spawned trajectory child.
//
// This is the second half of what ./dispatch.ts used to be: the resolver picks
// the program, this picks what that program reads. It moved out when the
// engagement verbs left the resolver, because one file carrying both a verb
// table and a six-hundred-line env translator is two contracts nobody reads
// at once.
//
// The translation itself now lives in ./params-to-env/, split by action family:
// which account and plan a run is admitted with, how a tabular action name
// becomes PLATFORM/VERB, what the Apple family must prove, what the
// content-described actions carry, and the paid-ads/store-release vocabulary.
// This file stays the entry point and, more importantly, the running order —
// later blocks deliberately overwrite earlier ones (SEARCH_QUERY, HEADLESS,
// WELES_LOGIN_ITEM), so the sequence below is part of the contract and a family
// must be applied where its blocks already stood.

import { applyAccountAndTaskAdmission } from './params-to-env/account-and-task-admission.js';
import { applyActionNameDispatch } from './params-to-env/action-name-dispatch.js';
import { applyAppleActionParams } from './params-to-env/apple-actions.js';
import { applyContentActionParams } from './params-to-env/content-actions.js';
import { applyPaidAdsActionParams } from './params-to-env/paid-ads-actions.js';

// Translate the per-row params JSON from account_action_logs into the env vars
// that the spawned trajectory subprocess reads.
//
// This is also where a submission is admitted or refused: a payload naming
// the wrong account, a malformed capture plan, an undeclared engagement or an
// undeclared observation throws HERE, before anything is spawned, so the
// caller gets the exact refusal sentence instead of a browser launched to
// discover the problem. No shared state, and the only reads are the
// engagement and observation declarations — release content, loaded once per
// process by ./declarations.ts.
export function paramsToEnv(
  params: Record<string, unknown>,
  action: string,
  trajPath: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  applyAccountAndTaskAdmission(params, trajPath, env);
  applyActionNameDispatch(params, action, trajPath, env);
  applyAppleActionParams(params, action, trajPath, env);
  applyContentActionParams(params, action, trajPath, env);
  applyPaidAdsActionParams(params, action, env);
  return env;
}
