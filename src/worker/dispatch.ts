// Verb → trajectory path resolver.
//
// Action rows in account_action_logs are named <platform>_<verb>. The worker
// pollerlooks up the .mjs path here and spawns it. Returning null means the
// action is not dispatchable and the row is skipped.
//
// Conventions used by the table below:
//   * <platform>_<verb>.mjs at the root for the "default" path (twitter/linkedin
//     comments, instagram likes, etc.) — the original layout.
//   * <platform>/<verb>.mjs or <platform>/actions/<verb>.mjs as a subdir
//     exception, used when (a) the root dir hit its file-count cap, or
//     (b) the trajectory grew enough adjacent files that grouping under
//     a per-platform subdir was clearer (github, reddit, tiktok action
//     atoms, content composers, etc.).
//
// Interaction verbs are not in this table. bookmark, comment, connect, dm,
// endorse, follow, join_server, join_sub, like, organic_comment,
// organic_issue_comment, organic_message, organic_reply, post, post_promote,
// promote, react, save, star, story_view, upvote, watch_repo and
// watch_through were one branch each, and the seven sites that carried all of
// them were 154 of the 255 actions this build used to admit — 108 of those
// rows resolving to a trajectory file nobody had written. They are one
// capability now: ./engagements.ts reads the declaration that names each
// engagement with its platform, its verb and its reviewed trajectory, and
// `generic_saved_task` replays it. A new engagement is a row in
// src/worker/deploy/weles-engagement-declaration.json; it is never a branch
// here.
//
// Benign-activity verbs are not in this table either. browse, dwell,
// notifications, profile_view and search were five branches covering nine
// sites — 37 of the 101 actions this build used to admit, and 30 of those
// rows resolved to the same single file, src/trajectories/_shared/benign.mjs.
// They are one capability now: ./observations.ts reads the declaration that
// names each observation with its platform, its verb, the origin it reads,
// what it must read there, its dwell budget and its reviewed trajectory, and
// `generic_keeper_task` runs it. A new site is a row in
// src/worker/deploy/weles-observation-declaration.json; it is never a branch
// here.
//
// A verb that survives here MUST add a branch; otherwise resolveTrajectory
// returns null and the queued row is silently skipped at the claim step.

import { ANALYTICS_SERVICE_ACTIONS } from './analytics-actions.js';

// The env translator is ./params-to-env.ts, re-exported here so
// `dist/worker/dispatch.js` stays the one module the API server, the Stado
// runner and the published measurement import.
export { paramsToEnv } from './params-to-env.js';

const analyticsServicePath = 'src/trajectories/_shared/analytics-service.mjs';

const PROXY_PROVIDERS = new Set([
  'iproyal', 'packetstream', 'brightdata', 'oxylabs',
  'anticaptcha', 'capmonster', 'capsolver', 'twocaptcha', 'nopecha',
  'sadcaptcha', 'pingproxies', 'juicysms', 'fivesim',
]);

const ROUTES: Record<string, (p: string) => string | null> = {
  browser_task: (p) => p === 'generic' ? 'src/trajectories/generic/browser_task.mjs' : null,
  saved_task: (p) => p === 'generic' ? 'src/trajectories/generic/saved_task.mjs' : null,
  // generic_keeper_task runs either a declared observation, resolved in
  // ./observations.ts before anything is spawned, or the keeper objective the
  // submission carries.
  keeper_task: (p) => p === 'generic' ? 'src/trajectories/generic/keeper_task.mjs' : null,
  // Evidence capture: stills/video of a product surface, and an axe-core
  // accessibility audit of the same page, both driven by explicit params
  // instead of a model. Artifacts land in stado://weles-captures/.
  capture: (p) => p === 'generic' ? 'src/trajectories/generic/capture.mjs' : null,
  accessibility_audit: (p) => p === 'generic' ? 'src/trajectories/generic/accessibility_audit.mjs' : null,
  key_followup: (p) => p === 'semanticscholar' ? 'src/trajectories/semanticscholar/key_followup.mjs' : null,
  version_history_scan: (p) => p === 'overleaf' ? 'src/trajectories/overleaf/version_history_ui_phrase.mjs' : null,
  push_github: (p) => p === 'overleaf' ? 'src/trajectories/overleaf/push_github.mjs' : null,
  pull_github: (p) => p === 'overleaf' ? 'src/trajectories/overleaf/pull_github.mjs' : null,

  health: (p) => p === 'github' ? 'src/trajectories/github/health/run.mjs' : `src/trajectories/${p}/health.mjs`,
  // Infra maintenance verbs (not social-account actions): resend_verify_domain_status
  // re-verifies stale inbound domains + confirms real receiving (no browser).
  verify_domain_status: (p) => `src/trajectories/${p}/verify_domain_status.mjs`,
  // Paid-growth/vendor workflows. Google Ads is browser-driven here; Meta has
  // both a browser fallback and an official-CLI wrapper. App store releases
  // are wired to the existing CLI-capable submission trajectories.
  ads_campaign: (p) => p === 'meta' ? 'src/trajectories/meta/ads_campaign.mjs'
    : p === 'google' ? 'src/trajectories/google/ads/ads_campaign.mjs'
    : null,
  ads_login: (p) => p === 'meta' ? 'src/trajectories/meta/ads_login.mjs'
    : p === 'google' ? 'src/trajectories/google/ads/ads_login.mjs'
    : null,
  ads_verify_access: (p) => p === 'meta' ? 'src/trajectories/meta/ads_verify_access.mjs'
    : p === 'google' ? 'src/trajectories/google/ads/ads_verify_access.mjs'
    : null,
  ads_cli_campaign: (p) => p === 'meta' ? 'src/trajectories/meta/ads_cli_campaign.mjs' : null,
  ads_api_campaign: (p) => p === 'meta' ? 'src/trajectories/meta/ads_api_campaign.mjs'
    : p === 'google' ? 'src/trajectories/google/ads/ads_api_campaign.mjs'
    : null,
  ads_api_catalog: (p) => p === 'meta' ? 'src/trajectories/meta/ads_api_catalog.mjs' : null,
  ads_api_audience: (p) => p === 'meta' ? 'src/trajectories/meta/ads_api_audience.mjs' : null,
  ads_api_creative: (p) => p === 'meta' ? 'src/trajectories/meta/ads_api_creative.mjs' : null,
  ads_api_lead_form: (p) => p === 'meta' ? 'src/trajectories/meta/ads_api_lead_form.mjs' : null,
  ads_api_messaging: (p) => p === 'meta' ? 'src/trajectories/meta/ads_api_messaging.mjs' : null,
  ads_performance: (p) => p === 'meta' ? 'src/trajectories/meta/ads_performance.mjs'
    : p === 'google' ? 'src/trajectories/google/ads/ads_performance.mjs'
    : null,
  ads_update_campaign: (p) => p === 'meta' ? 'src/trajectories/meta/ads_update_campaign.mjs'
    : p === 'google' ? 'src/trajectories/google/ads/ads_update_campaign.mjs'
    : null,
  ads_cli: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_auth_status: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_auth_doctor: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_auth_login: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_auth_discover: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_auth_token: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_auth_switch: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_auth_logout: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_api_setup_probe: (p) => p === 'apple' ? 'src/trajectories/apple/ads/api_client_setup_probe.mjs' : null,
  ads_me: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_acls: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_apps_search: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_apps_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_apps_localized_details: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_apps_assets_find: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_apps_eligibility_find: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_product_pages: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_product_page_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_product_page_countries: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_product_page_devices: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_product_page_locales: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_creatives: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_creative_find: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_creative_create: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_creative_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_geo_search: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_geo_resolve: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_campaigns: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_find: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_create: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_update: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_delete: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_pause: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_resume: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_groups: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_find: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_find_org: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_create: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_update: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_delete: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ads: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_find: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_find_org: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_create: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_update: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_delete: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_keywords: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_keyword_find: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_keyword_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_keyword_delete: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_keywords_update_bulk: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_keywords_create_bulk: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_keywords_delete_bulk: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keywords: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keyword_find: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keyword_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keywords_update_bulk: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keywords_create_bulk: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keywords_delete_bulk: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keywords: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keyword_find: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keyword_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keywords_create_bulk: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keywords_update_bulk: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keywords_delete_bulk: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_reports_campaigns: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_reports_ad_groups: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_reports_ads: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_reports_keywords: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_reports_search_terms: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_reports_ad_group_keywords: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_reports_ad_group_search_terms: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_reports_preset: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_impression_share_report: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_impression_share_reports: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_impression_share_report_create: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_impression_share_report_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_budget_orders: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_budget_order_create: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_budget_order_update: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_budget_order_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_rejection_reasons: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_rejection_reason_view: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  ads_api_request: (p) => p === 'apple' ? 'src/trajectories/apple/ads/run.mjs' : null,
  appstore_submit: (p) => p === 'apple' ? 'src/trajectories/apple/asc/asc_submit.mjs'
    : p === 'google' ? 'src/trajectories/google/play/play_submit.mjs'
    : null,
  appstore_analytics: (p) => p === 'apple' ? 'src/trajectories/apple/asc_analytics.mjs' : null,
  asc_submit: (p) => p === 'apple' ? 'src/trajectories/apple/asc/asc_submit.mjs' : null,
  asc_analytics: (p) => p === 'apple' ? 'src/trajectories/apple/asc_analytics.mjs' : null,
  play_submit: (p) => p === 'google' ? 'src/trajectories/google/play/play_submit.mjs' : null,
  // slack_post_message: Swiatowid posts MESSAGE_FILE to a channel/DM. Chained by
  // health checks (e.g. resend_verify_domain_status) to alert a human.
  post_message: (p) => `src/trajectories/${p}/post_message.mjs`,
  provision_user_token: (p) => p === 'slack' ? 'src/trajectories/slack/provision_user_token.mjs' : null,
  shadowban_check: (p) => `src/trajectories/${p}/shadowban_check.mjs`,
  register: (p) => {
    // youtube_register and google_register both run the canonical Gmail
    // signup flow at google/register.mjs (Material-Design comboboxes, SMS
    // already wired, QR-recovery path). Persists as platform='google' —
    // cross_login's PROVIDER_TO_ACCOUNT_PLATFORM is aligned to that.
    if (p === 'youtube' || p === 'google') return 'src/trajectories/google/register.mjs';
    if (p === 'github' || p === 'producthunt' || p === 'microsoft') return `src/trajectories/${p}/register.mjs`;
    if (p === 'apple') return 'src/trajectories/apple/register/run.mjs';
    if (p === 'facebook' || p === 'threads') return `src/trajectories/meta/${p}_register.mjs`;
    return `src/trajectories/${p}_register.mjs`;
  },
  login: (p) => {
    // codex and claude keep their login beside their reauth, in a directory, and
    // the flat fallback below looked for `<plat>_login.mjs` and found nothing.
    // Nothing could start the one trajectory that renews those subscriptions:
    // the reauth path declines to log in on a burnt tick by design, so a
    // dispatcher that cannot reach the login left no automatic way back at all.
    // kimi's login has the same shape and takes the same login_item selector, so
    // it belongs in the same branch.
    if (p === 'apple' || p === 'microsoft' || p === 'codex' || p === 'claude' || p === 'kimi') {
      return `src/trajectories/${p}/login.mjs`;
    }
    if (p === 'facebook' || p === 'threads') return `src/trajectories/meta/${p}_login.mjs`;
    return `src/trajectories/${p}_login.mjs`;
  },
  create_developer_id: (p) => p === 'apple' ? 'src/trajectories/apple/create_developer_id.mjs' : null,
  login_search: (p) => p === 'gmail' ? 'src/trajectories/gmail/gmail_login_search.mjs' : null,
  // Cross-platform OAuth login. Action shape: <platform>_login_via_<provider>,
  // e.g. reddit_login_via_apple, tiktok_login_via_google, linkedin_login_via_microsoft.
  // The verb-side dispatcher below catches `login_via_<provider>` and routes to
  // the parametric runner; provider is extracted from the verb suffix in
  // paramsToEnv and surfaced as PROVIDER env.
  login_via: () => 'src/trajectories/cross_login/run.mjs',

  profile: (p) => p === 'producthunt' ? 'src/trajectories/producthunt/profile.mjs' : `src/trajectories/${p}_profile.mjs`,
  // edit_profile = write character persona content (bio, display_name, optional
  // external_url) onto the platform's /accounts/edit form. github goes under
  // <platform>/content/ because github/actions/ is at the 5-file cap;
  // every other platform follows the actions/ convention.
  edit_profile: (p) => (p === 'github' || p === 'reddit') ? `src/trajectories/${p}/content/edit_profile.mjs` : `src/trajectories/${p}/actions/edit_profile.mjs`,
  create_repo: (p) => `src/trajectories/${p}/content/create_repo.mjs`,
  commit: (p) => `src/trajectories/${p}/content/commit.mjs`,
  fork: (p) => `src/trajectories/${p}/content/fork.mjs`,
  open_issue: (p) => `src/trajectories/${p}/content/open_issue.mjs`,
  submit: (p) => `src/trajectories/${p}/content/submit.mjs`,
  submit_promote: (p) => `src/trajectories/${p}/content/submit.mjs`,
  reset_password: (p) => p === 'github' ? 'src/trajectories/github/recover/reset_password.mjs' : `src/trajectories/${p}_reset_password.mjs`,
  verify_password: (p) => p === 'microsoft' ? 'src/trajectories/microsoft_verify_password.mjs' : null,
  adopt_password: (p) => p === 'microsoft' ? 'src/trajectories/microsoft_adopt_password.mjs' : null,
  // Entra directory identities are a separate lifecycle from consumer Microsoft
  // accounts: <platform>_<verb> splits on the first underscore, so the verb here
  // is entra_adopt_password / entra_reset_password / entra_verify_password on
  // platform microsoft.
  entra_adopt_password: (p) => p === 'microsoft' ? 'src/trajectories/microsoft_entra_adopt_password.mjs' : null,
  entra_reset_password: (p) => p === 'microsoft' ? 'src/trajectories/microsoft_entra_reset_password.mjs' : null,
  entra_verify_password: (p) => p === 'microsoft' ? 'src/trajectories/microsoft_entra_verify_password.mjs' : null,
  balance: (p) => PROXY_PROVIDERS.has(p) ? `src/trajectories/${p}/balance.mjs` : `src/trajectories/${p}_balance.mjs`,
  topup: (p) => PROXY_PROVIDERS.has(p) ? `src/trajectories/${p}/topup.mjs` : null,
  analyze_text: (p) => p === 'pangram' ? 'src/trajectories/pangram/analyze_text.mjs' : null,
  pangram_audit_new_wniosek: (p) => p === 'ncbr' ? 'src/trajectories/ncbr/pangram_audit_new_wniosek.mjs' : null,
  apply_correction: (p) => p === 'ncbr' ? 'src/trajectories/ncbr/apply_correction.mjs' : null,
  verify_correction: (p) => p === 'ncbr' ? 'src/trajectories/ncbr/apply_correction.mjs' : null,
  // On-demand ticker scrape: wisent-app inserts an account_action_logs row
  // with action='unusualwhales_scrape' or 'volumeleaders_scrape' and
  // params={ticker, page}; the worker spawns the existing scrape script.
  scrape: (p) => (p === 'unusualwhales' || p === 'volumeleaders' || p === 'tradingview')
    ? `src/trajectories/${p}/scrape.mjs`
    : null,
};

export function resolveTrajectory(action: string): string | null {
  const firstUnderscore = action.indexOf('_');
  if (firstUnderscore < 0) return null;
  if (ANALYTICS_SERVICE_ACTIONS.has(action)) return analyticsServicePath;
  const plat = action.slice(0, firstUnderscore);
  const verb = action.slice(firstUnderscore + 1);
  // Cross-login: collapse every login_via_<provider> verb onto a single
  // parametric runner. The provider is parsed out in paramsToEnv into PROVIDER.
  if (verb.startsWith('login_via_')) {
    const router = ROUTES['login_via'];
    return router ? router(plat) : null;
  }
  const router = ROUTES[verb];
  return router ? router(plat) : null;
}

