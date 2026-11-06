// Navigation + reachability + assertAuthed gate of the shared action runner,
// with cfg.inlineRelogin support so engagement trajectories can recover from
// a signed-out session on the SAME WSession (rather than dying + queueing a
// routine tick that lands on a different proxy sticky and re-burns).
// Whether the session reached the site is Chromium's error page
// (`../action/reachable.mjs`); whether it is signed in is the DOM probe
// (`../auth/auth-probe.mjs`), never words in the address. A failed gate is
// thrown with its banSignal attached.

import { assertAuthed, AuthProbeError } from '../auth/auth-probe.mjs';
import { HEALTH_SIGNAL } from '../auth/ban-signal.mjs';
import { pageSettled } from '../page/settled.mjs';
import { checkReachable } from '../action/reachable.mjs';

async function authPass({ s, cfg, feed, label }) {
  await s.goto(feed);
  checkReachable(s, cfg.platform);
  await pageSettled(s.page);
  await assertAuthed(cfg.platform, s, { label });
}

/**
 * Open `feed` signed in. On a first attempt that finds the session signed
 * out (a checkpoint), and when cfg.inlineRelogin is supplied, the relogin
 * runs on the SAME session and the gate is passed once more; otherwise the
 * failure is thrown as it was met.
 */
export async function runAuthGate({ s, cfg, acct, feed, label }) {
  try {
    await authPass({ s, cfg, feed, label });
    return;
  } catch (error) {
    if (
      error.banSignal?.signal !== HEALTH_SIGNAL.checkpoint ||
      typeof cfg.inlineRelogin !== 'function'
    )
      throw error;
    console.log(
      `[auth-gate] ${cfg.platform}/${cfg.action} signed out on attempt 1 (${error.message}) — running inline relogin`,
    );
    const relogin = await cfg.inlineRelogin(s, acct);
    if (!relogin?.ok) {
      error.message = `${error.message}; inline relogin did not pass: ${relogin?.reason ? relogin.reason : 'the relogin returned no reason'}`;
      throw error;
    }
  }
  console.log(
    `[auth-gate] inline relogin PASSED — retrying ${cfg.platform}/${cfg.action} auth gate`,
  );
  await authPass({ s, cfg, feed, label });
}

export { AuthProbeError };
