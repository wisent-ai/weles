// Worker action routes outside paid advertising.
const PROXY_PROVIDERS = new Set([
  'iproyal',
  'packetstream',
  'brightdata',
  'oxylabs',
  'anticaptcha',
  'capmonster',
  'capsolver',
  'twocaptcha',
  'nopecha',
  'sadcaptcha',
  'pingproxies',
  'juicysms',
  'fivesim',
]);

/**
 * The platforms whose register is not at `<platform>/register.mjs`.
 * youtube_register and google_register both run the canonical Gmail signup
 * flow at google/register.mjs (Material-Design comboboxes, SMS already wired,
 * QR-recovery path), persisting as platform='google'; cross_login's
 * PROVIDER_TO_ACCOUNT_PLATFORM is aligned to that. Meta's platforms keep
 * their flows under meta/.
 */
const REGISTER_SCRIPTS: Record<string, string> = {
  youtube: 'src/trajectories/google/register.mjs',
  google: 'src/trajectories/google/register.mjs',
  apple: 'src/trajectories/apple/register/run.mjs',
  facebook: 'src/trajectories/meta/facebook_register.mjs',
  threads: 'src/trajectories/meta/threads_register.mjs',
};

/** Meta's platforms, whose login lives under meta/<platform>_login.mjs. */
const META_PLATFORMS: Record<string, true> = { facebook: true, threads: true };

/**
 * The platforms whose edit_profile is under <platform>/content/ (github's
 * actions/ folder is at the 5-file cap); every other one is under actions/.
 */
const CONTENT_EDIT_PROFILE: Record<string, true> = {
  github: true,
  reddit: true,
};

/**
 * The platforms with an on-demand ticker scrape: wisent-app inserts an
 * account_action_logs row with action='<platform>_scrape' and
 * params={ticker, page}; the worker spawns that platform's scrape script.
 */
const SCRAPERS: Record<string, true> = {
  unusualwhales: true,
  volumeleaders: true,
  tradingview: true,
};
// Action protocol names mapped to their existing direct-message entry points.
const DIRECT_MESSAGE_SCRIPTS: Record<string, string> = {
  discord: 'src/trajectories/discord/actions/engagement/dm.mjs',
  instagram: 'src/trajectories/instagram/actions/engagement/dm.mjs',
  linkedin: 'src/trajectories/linkedin/actions/engagement/dm.mjs',
  reddit: 'src/trajectories/reddit/dm/dm.mjs',
  snapchat: 'src/trajectories/snapchat/dm.mjs',
  tiktok: 'src/trajectories/tiktok/dm/dm.mjs',
  twitter: 'src/trajectories/twitter/actions/engagement/dm.mjs',
};

export const STANDARD_ROUTES: Record<string, (p: string) => string | null> = {
  browser_task: (p) =>
    p === 'generic' ? 'src/trajectories/generic/browser_task.mjs' : null,
  saved_task: (p) =>
    p === 'generic' ? 'src/trajectories/generic/saved_task.mjs' : null,
  // generic_keeper_task runs either a declared observation, resolved in
  // ./observations.ts before anything is spawned, or the keeper objective the
  // submission carries.
  keeper_task: (p) =>
    p === 'generic' ? 'src/trajectories/generic/keeper_task.mjs' : null,
  // Evidence capture: stills/video of a product surface, and an axe-core
  // accessibility audit of the same page, both driven by explicit params
  // instead of a model. Artifacts land in stado://weles-captures/.
  capture: (p) =>
    p === 'generic' ? 'src/trajectories/generic/capture.mjs' : null,
  accessibility_audit: (p) =>
    p === 'generic' ? 'src/trajectories/generic/accessibility_audit.mjs' : null,
  key_followup: (p) =>
    p === 'semanticscholar'
      ? 'src/trajectories/semanticscholar/key_followup.mjs'
      : null,
  version_history_scan: (p) =>
    p === 'overleaf'
      ? 'src/trajectories/overleaf/version_history_ui_phrase.mjs'
      : null,
  push_github: (p) =>
    p === 'overleaf' ? 'src/trajectories/overleaf/push_github.mjs' : null,
  pull_github: (p) =>
    p === 'overleaf' ? 'src/trajectories/overleaf/pull_github.mjs' : null,

  dm: (p) =>
    Object.hasOwn(DIRECT_MESSAGE_SCRIPTS, p) ? DIRECT_MESSAGE_SCRIPTS[p] : null,
  health: (p) =>
    p === 'github'
      ? 'src/trajectories/github/health/run.mjs'
      : `src/trajectories/${p}/health.mjs`,
  // Infra maintenance verbs (not social-account actions): resend_verify_domain_status
  // re-verifies stale inbound domains + confirms real receiving (no browser).
  verify_domain_status: (p) => `src/trajectories/${p}/verify_domain_status.mjs`,
  appstore_submit: (p) =>
    p === 'apple'
      ? 'src/trajectories/apple/asc/asc_submit.mjs'
      : p === 'google'
        ? 'src/trajectories/google/play/play_submit.mjs'
        : null,
  appstore_analytics: (p) =>
    p === 'apple' ? 'src/trajectories/apple/asc_analytics.mjs' : null,
  asc_submit: (p) =>
    p === 'apple' ? 'src/trajectories/apple/asc/asc_submit.mjs' : null,
  asc_analytics: (p) =>
    p === 'apple' ? 'src/trajectories/apple/asc_analytics.mjs' : null,
  play_submit: (p) =>
    p === 'google' ? 'src/trajectories/google/play/play_submit.mjs' : null,
  // slack_post_message: Swiatowid posts MESSAGE_FILE to a channel/DM. Chained by
  // health checks (e.g. resend_verify_domain_status) to alert a human.
  post_message: (p) => `src/trajectories/${p}/post_message.mjs`,
  provision_user_token: (p) =>
    p === 'slack' ? 'src/trajectories/slack/provision_user_token.mjs' : null,
  shadowban_check: (p) => `src/trajectories/${p}/shadowban_check.mjs`,
  register: (p) =>
    Object.hasOwn(REGISTER_SCRIPTS, p)
      ? REGISTER_SCRIPTS[p]
      : `src/trajectories/${p}/register.mjs`,
  // Every platform keeps its login beside its register, in its own directory.
  // The flat `<plat>_login.mjs` layout this replaced had left codex, claude
  // and kimi unreachable once: the reauth path declines to log in on a burnt
  // tick by design, so a dispatcher that cannot reach the login left no
  // automatic way back at all.
  login: (p) =>
    Object.hasOwn(META_PLATFORMS, p)
      ? `src/trajectories/meta/${p}_login.mjs`
      : `src/trajectories/${p}/login.mjs`,
  create_developer_id: (p) =>
    p === 'apple' ? 'src/trajectories/apple/create_developer_id.mjs' : null,
  accept_agreement: (p) =>
    p === 'apple' ? 'src/trajectories/apple/accept_agreement.mjs' : null,
  login_search: (p) =>
    p === 'gmail' ? 'src/trajectories/gmail/gmail_login_search.mjs' : null,
  // Cross-platform OAuth login. Action shape: <platform>_login_via_<provider>,
  // e.g. reddit_login_via_apple, tiktok_login_via_google, linkedin_login_via_microsoft.
  // The verb-side dispatcher below catches `login_via_<provider>` and routes to
  // the parametric runner; provider is extracted from the verb suffix in
  // paramsToEnv and surfaced as PROVIDER env.
  login_via: () => 'src/trajectories/cross_login/run.mjs',

  profile: (p) => `src/trajectories/${p}/profile.mjs`,
  // edit_profile = write character persona content (bio, display_name, optional
  // external_url) onto the platform's /accounts/edit form. github goes under
  // <platform>/content/ because github/actions/ is at the 5-file cap;
  // every other platform follows the actions/ convention.
  edit_profile: (p) =>
    Object.hasOwn(CONTENT_EDIT_PROFILE, p)
      ? `src/trajectories/${p}/content/edit_profile.mjs`
      : `src/trajectories/${p}/actions/edit_profile.mjs`,
  create_repo: (p) => `src/trajectories/${p}/content/create_repo.mjs`,
  commit: (p) => `src/trajectories/${p}/content/commit.mjs`,
  fork: (p) => `src/trajectories/${p}/content/fork.mjs`,
  open_issue: (p) => `src/trajectories/${p}/content/open_issue.mjs`,
  submit: (p) => `src/trajectories/${p}/content/submit.mjs`,
  submit_promote: (p) => `src/trajectories/${p}/content/submit.mjs`,
  // Credential recovery lives under <platform>/recover/, beside the login it
  // repairs.
  reset_password: (p) => `src/trajectories/${p}/recover/reset_password.mjs`,
  verify_password: (p) =>
    p === 'microsoft'
      ? 'src/trajectories/microsoft/recover/verify_password.mjs'
      : null,
  adopt_password: (p) =>
    p === 'microsoft'
      ? 'src/trajectories/microsoft/recover/adopt_password.mjs'
      : null,
  // Entra directory identities are a separate lifecycle from consumer Microsoft
  // accounts: <platform>_<verb> splits on the first underscore, so the verb here
  // is entra_adopt_password / entra_reset_password / entra_verify_password on
  // platform microsoft.
  entra_adopt_password: (p) =>
    p === 'microsoft'
      ? 'src/trajectories/microsoft/entra/adopt_password.mjs'
      : null,
  entra_reset_password: (p) =>
    p === 'microsoft'
      ? 'src/trajectories/microsoft/entra/reset_password.mjs'
      : null,
  entra_verify_password: (p) =>
    p === 'microsoft'
      ? 'src/trajectories/microsoft/entra/verify_password.mjs'
      : null,
  balance: (p) => `src/trajectories/${p}/balance.mjs`,
  topup: (p) =>
    PROXY_PROVIDERS.has(p) ? `src/trajectories/${p}/topup.mjs` : null,
  analyze_text: (p) =>
    p === 'pangram' ? 'src/trajectories/pangram/analyze_text.mjs' : null,
  pangram_audit_new_wniosek: (p) =>
    p === 'ncbr' ? 'src/trajectories/ncbr/pangram_audit_new_wniosek.mjs' : null,
  apply_correction: (p) =>
    p === 'ncbr' ? 'src/trajectories/ncbr/apply_correction.mjs' : null,
  verify_correction: (p) =>
    p === 'ncbr' ? 'src/trajectories/ncbr/apply_correction.mjs' : null,
  // On-demand ticker scrape: wisent-app inserts an account_action_logs row
  // with action='unusualwhales_scrape' or 'volumeleaders_scrape' and
  // params={ticker, page}; the worker spawns the existing scrape script.
  scrape: (p) =>
    Object.hasOwn(SCRAPERS, p) ? `src/trajectories/${p}/scrape.mjs` : null,
  // google_authenticator_enrol: enrol a Google Authenticator for one
  // Skarbiec login item and store its seed there (params.login_item).
  authenticator_enrol: (p) =>
    p === 'google' ? 'src/trajectories/google/authenticator/enrol.mjs' : null,
  mfa_status: (p) =>
    p === 'google' ? 'src/trajectories/google/authenticator/status.mjs' : null,
  // google_app_password: create a Google app password for one Skarbiec login
  // item and hand it to `skrzynka account app-password --provider gmail` (params.login_item).
  app_password: (p) =>
    p === 'google' ? 'src/trajectories/google/app_password/create.mjs' : null,
};
