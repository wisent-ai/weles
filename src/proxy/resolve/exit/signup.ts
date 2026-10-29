// Exits LinkedIn's cold signup challenges, kept in Skarbiec's Weles
// settings as `linkedin_signup_challenged_exits`:
//   { exits: [{ address, reason }] }
// These are signup exclusions, not account exclusions: an account session can
// stay healthy on an exit that a cold signup is challenged on, so they apply
// only while the running trajectory is linkedin_register. A warm-signup
// experiment runs on the profile it warmed and names it, so a register run
// that names a warmed profile may use those exits on purpose; a cold run names
// none. Read on every question, so an exit recorded a moment ago applies now;
// a setting nobody wrote excludes nothing.
import { isIP } from 'node:net';
import { readSetting } from '../../../state/skarbiec-records.js';

type ChallengedExit = { address: string; reason: string };
type ChallengedExits = { exits: ChallengedExit[] };

const SETTING = 'linkedin_signup_challenged_exits';
/** The trajectory whose cold signup these exits are challenged on. */
const SIGNUP_RUNNER = /\blinkedin_register\b/;
/** The warmed profile a warm-signup experiment names (warm_signup_profile.mjs). */
const WARMED_PROFILE = 'LINKEDIN_REGISTER_WARM_PROFILE_DIR';

/** Whether the running trajectory is a LinkedIn signup, by its action and labels. */
export function isLinkedinSignupContext(): boolean {
  const labels = [
    process.env.ACTION,
    process.env.WELES_LABEL,
    process.env.WELES_PROXY_DIAGNOSTICS_LABEL,
  ].filter((label): label is string => label !== undefined);
  return labels.some((label) => SIGNUP_RUNNER.test(label));
}

/** Whether this signup is the warm-signup experiment: it names the profile it warmed. */
export function isLinkedinWarmedSignupExperiment(): boolean {
  return isLinkedinSignupContext() && !!process.env[WARMED_PROFILE];
}

/** Why a cold LinkedIn signup must not use `exitIp`, or nothing when it may. */
export function linkedinSignupExitBurnReason(
  exitIp: string | undefined,
): string | undefined {
  if (!exitIp || !isLinkedinSignupContext()) return undefined;
  if (isLinkedinWarmedSignupExperiment()) return undefined;
  const declared = readSetting<ChallengedExits>(SETTING, { exits: [] });
  for (const { address } of declared.exits)
    if (!isIP(address))
      throw new Error(`${SETTING} names ${address}, which is not an address`);
  return declared.exits.find((entry) => entry.address === exitIp)?.reason;
}
