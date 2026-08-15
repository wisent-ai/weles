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
// New trajectories MUST add a branch here; otherwise resolveTrajectory will
// return null and the queued row will be silently skipped at the claim step.

import { parseAppleLoginCapabilities } from '../utils/apple-login-capabilities.js';

const benignPath = 'scripts/trajectories/_shared/benign.mjs';
const analyticsServicePath = 'scripts/trajectories/_shared/analytics-service.mjs';

const ANALYTICS_SERVICE_ACTIONS = new Set([
  'umami_register',
  'umami_login',
  'umami_create_website',
  'umami_find_website',
  'umami_get_website_id',
  'umami_get_tracking_snippet',
  'umami_update_website_settings',
  'umami_verify_tracking_script',
  'umami_verify_realtime_event',
  'umami_view_realtime',
  'umami_view_summary',
  'umami_view_pages',
  'umami_view_referrers',
  'umami_view_events',
  'umami_track_custom_event',
  'umami_view_sessions',
  'umami_create_report',
  'umami_view_funnels',
  'umami_view_goals',
  'umami_view_user_journeys',
  'umami_view_retention',
  'umami_view_cohorts',
  'umami_view_utm_campaigns',
  'umami_api_query',
  'umami_create_share_url',
  'umami_manage_user_access',
  'umami_export_report',
  'googleanalytics_register',
  'googleanalytics_register_needher',
  'googleanalytics_login',
  'googleanalytics_find_property',
  'googleanalytics_create_account',
  'googleanalytics_create_property',
  'googleanalytics_create_web_stream',
  'googleanalytics_get_measurement_id',
  'googleanalytics_get_global_site_tag',
  'googleanalytics_create_measurement_protocol_secret',
  'googleanalytics_install_gtag',
  'googleanalytics_verify_realtime',
  'googleanalytics_view_debugview',
  'googleanalytics_view_realtime',
  'googleanalytics_run_data_api_report',
  'googleanalytics_view_acquisition',
  'googleanalytics_view_engagement',
  'googleanalytics_view_pages',
  'googleanalytics_create_key_event',
  'googleanalytics_view_key_events',
  'googleanalytics_create_audience',
  'googleanalytics_create_custom_dimension',
  'googleanalytics_create_custom_metric',
  'googleanalytics_link_search_console',
  'googleanalytics_link_google_ads',
  'googleanalytics_update_data_retention',
  'googleanalytics_add_user',
  'googleanalytics_export_report',
]);

const PROXY_PROVIDERS = new Set([
  'iproyal', 'packetstream', 'brightdata', 'oxylabs',
  'anticaptcha', 'capmonster', 'capsolver', 'twocaptcha', 'nopecha',
  'sadcaptcha', 'pingproxies', 'juicysms', 'fivesim',
]);

const ROUTES: Record<string, (p: string) => string | null> = {
  // Generic surface ticks dispatch to the benign runner which reads PLATFORM/VERB env.
  dwell: () => benignPath, notifications: () => benignPath, search: () => benignPath, profile_view: () => benignPath,
  browser_task: (p) => p === 'generic' ? 'scripts/trajectories/generic/browser_task.mjs' : null,
  saved_task: (p) => p === 'generic' ? 'scripts/trajectories/generic/saved_task.mjs' : null,
  keeper_task: (p) => p === 'generic' ? 'scripts/trajectories/generic/keeper_task.mjs' : null,
  key_followup: (p) => p === 'semanticscholar' ? 'scripts/trajectories/semanticscholar/key_followup.mjs' : null,
  version_history_scan: (p) => p === 'overleaf' ? 'scripts/trajectories/overleaf/version_history_ui_phrase.mjs' : null,
  push_github: (p) => p === 'overleaf' ? 'scripts/trajectories/overleaf/push_github.mjs' : null,
  pull_github: (p) => p === 'overleaf' ? 'scripts/trajectories/overleaf/pull_github.mjs' : null,

  browse: (p) => p === 'github' ? 'scripts/trajectories/github/actions/browse.mjs' : `scripts/trajectories/${p}/browse.mjs`,
  health: (p) => p === 'github' ? 'scripts/trajectories/github/health/run.mjs' : `scripts/trajectories/${p}/health.mjs`,
  // Infra maintenance verbs (not social-account actions): resend_verify_domain_status
  // re-verifies stale inbound domains + confirms real receiving (no browser).
  verify_domain_status: (p) => `scripts/trajectories/${p}/verify_domain_status.mjs`,
  // Paid-growth/vendor workflows. Google Ads is browser-driven here; Meta has
  // both a browser fallback and an official-CLI wrapper. App store releases
  // are wired to the existing CLI-capable submission trajectories.
  ads_campaign: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_campaign.mjs'
    : p === 'google' ? 'scripts/trajectories/google/ads/ads_campaign.mjs'
    : null,
  ads_login: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_login.mjs'
    : p === 'google' ? 'scripts/trajectories/google/ads/ads_login.mjs'
    : null,
  ads_verify_access: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_verify_access.mjs'
    : p === 'google' ? 'scripts/trajectories/google/ads/ads_verify_access.mjs'
    : null,
  ads_cli_campaign: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_cli_campaign.mjs' : null,
  ads_api_campaign: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_api_campaign.mjs'
    : p === 'google' ? 'scripts/trajectories/google/ads/ads_api_campaign.mjs'
    : null,
  ads_api_catalog: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_api_catalog.mjs' : null,
  ads_api_audience: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_api_audience.mjs' : null,
  ads_api_creative: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_api_creative.mjs' : null,
  ads_api_lead_form: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_api_lead_form.mjs' : null,
  ads_api_messaging: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_api_messaging.mjs' : null,
  ads_performance: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_performance.mjs'
    : p === 'google' ? 'scripts/trajectories/google/ads/ads_performance.mjs'
    : null,
  ads_update_campaign: (p) => p === 'meta' ? 'scripts/trajectories/meta/ads_update_campaign.mjs'
    : p === 'google' ? 'scripts/trajectories/google/ads/ads_update_campaign.mjs'
    : null,
  ads_cli: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_auth_status: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_auth_doctor: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_auth_login: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_auth_discover: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_auth_token: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_auth_switch: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_auth_logout: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_api_setup_probe: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/api_client_setup_probe.mjs' : null,
  ads_me: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_acls: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_apps_search: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_apps_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_apps_localized_details: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_apps_assets_find: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_apps_eligibility_find: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_product_pages: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_product_page_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_product_page_countries: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_product_page_devices: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_product_page_locales: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_creatives: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_creative_find: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_creative_create: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_creative_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_geo_search: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_geo_resolve: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_campaigns: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_find: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_create: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_update: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_delete: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_pause: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_campaign_resume: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_groups: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_find: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_find_org: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_create: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_update: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_delete: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ads: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_find: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_find_org: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_create: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_update: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_delete: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_keywords: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_keyword_find: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_keyword_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_keyword_delete: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_keywords_update_bulk: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_keywords_create_bulk: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_keywords_delete_bulk: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keywords: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keyword_find: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keyword_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keywords_update_bulk: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keywords_create_bulk: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_negative_keywords_delete_bulk: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keywords: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keyword_find: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keyword_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keywords_create_bulk: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keywords_update_bulk: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_ad_group_negative_keywords_delete_bulk: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_reports_campaigns: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_reports_ad_groups: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_reports_ads: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_reports_keywords: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_reports_search_terms: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_reports_ad_group_keywords: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_reports_ad_group_search_terms: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_reports_preset: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_impression_share_report: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_impression_share_reports: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_impression_share_report_create: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_impression_share_report_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_budget_orders: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_budget_order_create: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_budget_order_update: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_budget_order_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_rejection_reasons: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_rejection_reason_view: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  ads_api_request: (p) => p === 'apple' ? 'scripts/trajectories/apple/ads/run.mjs' : null,
  native_2fa: (_p) => null,
  appstore_submit: (p) => p === 'apple' ? 'scripts/trajectories/apple/asc/asc_submit.mjs'
    : p === 'google' ? 'scripts/trajectories/google/play/play_submit.mjs'
    : null,
  appstore_analytics: (p) => p === 'apple' ? 'scripts/trajectories/apple/asc_analytics.mjs' : null,
  asc_submit: (p) => p === 'apple' ? 'scripts/trajectories/apple/asc/asc_submit.mjs' : null,
  asc_analytics: (p) => p === 'apple' ? 'scripts/trajectories/apple/asc_analytics.mjs' : null,
  play_submit: (p) => p === 'google' ? 'scripts/trajectories/google/play/play_submit.mjs' : null,
  // slack_post_message: Swiatowid posts MESSAGE_FILE to a channel/DM. Chained by
  // health checks (e.g. resend_verify_domain_status) to alert a human.
  post_message: (p) => `scripts/trajectories/${p}/post_message.mjs`,
  provision_user_token: (p) => p === 'slack' ? 'scripts/trajectories/slack/provision_user_token.mjs' : null,
  shadowban_check: (p) => `scripts/trajectories/${p}/shadowban_check.mjs`,
  organic_comment: (p) => `scripts/trajectories/${p}/organic_comment.mjs`,
  organic_reply: (p) => `scripts/trajectories/${p}/organic_reply.mjs`,
  organic_message: (p) => `scripts/trajectories/${p}/organic_message.mjs`,
  organic_issue_comment: (p) => `scripts/trajectories/${p}/actions/organic_issue_comment.mjs`,
  promote: (p) => p === 'github' ? 'scripts/trajectories/github/actions/promote.mjs' : `scripts/trajectories/${p}/promote.mjs`,
  register: (p) => {
    // youtube_register and google_register both run the canonical Gmail
    // signup flow at google/register.mjs (Material-Design comboboxes, SMS
    // already wired, QR-recovery path). Persists as platform='google' —
    // cross_login's PROVIDER_TO_ACCOUNT_PLATFORM is aligned to that.
    if (p === 'youtube' || p === 'google') return 'scripts/trajectories/google/register.mjs';
    if (p === 'github' || p === 'producthunt' || p === 'microsoft') return `scripts/trajectories/${p}/register.mjs`;
    if (p === 'apple') return 'scripts/trajectories/apple/register/run.mjs';
    if (p === 'facebook' || p === 'threads') return `scripts/trajectories/meta/${p}_register.mjs`;
    return `scripts/trajectories/${p}_register.mjs`;
  },
  login: (p) => {
    // codex and claude keep their login beside their reauth, in a directory, and
    // the flat fallback below looked for `<plat>_login.mjs` and found nothing.
    // Nothing could start the one trajectory that renews those subscriptions:
    // the reauth path declines to log in on a burnt tick by design, so a
    // dispatcher that cannot reach the login left no automatic way back at all.
    if (p === 'apple' || p === 'microsoft' || p === 'codex' || p === 'claude') {
      return `scripts/trajectories/${p}/login.mjs`;
    }
    if (p === 'facebook' || p === 'threads') return `scripts/trajectories/meta/${p}_login.mjs`;
    return `scripts/trajectories/${p}_login.mjs`;
  },
  create_developer_id: (p) => p === 'apple' ? 'scripts/trajectories/apple/create_developer_id.mjs' : null,
  login_search: (p) => p === 'gmail' ? 'scripts/trajectories/gmail/gmail_login_search.mjs' : null,
  // Cross-platform OAuth login. Action shape: <platform>_login_via_<provider>,
  // e.g. reddit_login_via_apple, tiktok_login_via_google, linkedin_login_via_microsoft.
  // The verb-side dispatcher below catches `login_via_<provider>` and routes to
  // the parametric runner; provider is extracted from the verb suffix in
  // paramsToEnv and surfaced as PROVIDER env.
  login_via: () => 'scripts/trajectories/cross_login/run.mjs',
  comment: (p) => p === 'producthunt' ? 'scripts/trajectories/producthunt/comment.mjs' : `scripts/trajectories/${p}_comment.mjs`,

  // Twitter DM is at the root; instagram/linkedin/discord/snapchat under
  // <platform>/dm.mjs; tiktok/reddit under <platform>/dm/dm.mjs because the
  // parent dirs were at the file-count cap when the DM trajectories landed.
  dm: (p) => p === 'twitter' ? 'scripts/trajectories/twitter_dm.mjs'
    : (p === 'tiktok' || p === 'reddit') ? `scripts/trajectories/${p}/dm/dm.mjs`
    : `scripts/trajectories/${p}/dm.mjs`,

  profile: (p) => p === 'producthunt' ? 'scripts/trajectories/producthunt/profile.mjs' : `scripts/trajectories/${p}_profile.mjs`,
  // edit_profile = write character persona content (bio, display_name, optional
  // external_url) onto the platform's /accounts/edit form. github goes under
  // <platform>/content/ because github/actions/ is at the 5-file cap;
  // every other platform follows the actions/ convention.
  edit_profile: (p) => (p === 'github' || p === 'reddit') ? `scripts/trajectories/${p}/content/edit_profile.mjs` : `scripts/trajectories/${p}/actions/edit_profile.mjs`,
  upvote: (p) => p === 'reddit' ? 'scripts/trajectories/reddit/actions/upvote.mjs'
    : p === 'producthunt' ? 'scripts/trajectories/producthunt/upvote.mjs'
    : `scripts/trajectories/${p}_upvote.mjs`,

  // Twitter + Instagram have deterministic Playwright variants at the root;
  // the platform/actions/ agent-loop variants hit max-iter on X's heart icon.
  like: (p) => (p === 'twitter' || p === 'instagram') ? `scripts/trajectories/${p}_like.mjs`
    : (p === 'linkedin' || p === 'tiktok') ? `scripts/trajectories/${p}/actions/like.mjs`
    : `scripts/trajectories/${p}_like.mjs`,
  follow: (p) => (p === 'twitter' || p === 'instagram') ? `scripts/trajectories/${p}_follow.mjs`
    : (p === 'reddit' || p === 'tiktok' || p === 'github') ? `scripts/trajectories/${p}/actions/follow.mjs`
    : `scripts/trajectories/${p}_follow.mjs`,
  star: (p) => p === 'github' ? 'scripts/trajectories/github/star/run.mjs' : `scripts/trajectories/${p}_star.mjs`,
  create_repo: (p) => `scripts/trajectories/${p}/content/create_repo.mjs`,
  commit: (p) => `scripts/trajectories/${p}/content/commit.mjs`,
  fork: (p) => `scripts/trajectories/${p}/content/fork.mjs`,
  open_issue: (p) => `scripts/trajectories/${p}/content/open_issue.mjs`,
  post: (p) => `scripts/trajectories/${p}/content/post.mjs`,
  post_promote: (p) => `scripts/trajectories/${p}/content/post.mjs`,
  submit: (p) => `scripts/trajectories/${p}/content/submit.mjs`,
  submit_promote: (p) => `scripts/trajectories/${p}/content/submit.mjs`,
  connect: (p) => `scripts/trajectories/${p}/actions/connect.mjs`,
  endorse: (p) => `scripts/trajectories/${p}/actions/endorse.mjs`,
  react: (p) => `scripts/trajectories/${p}/actions/react.mjs`,
  join_server: (p) => `scripts/trajectories/${p}/actions/join_server.mjs`,
  join_sub: (p) => `scripts/trajectories/${p}/actions/join_sub.mjs`,
  watch_repo: (p) => `scripts/trajectories/${p}/actions/watch_repo.mjs`,
  story_view: (p) => `scripts/trajectories/${p}/actions/story_view.mjs`,
  watch_through: (p) => `scripts/trajectories/${p}/actions/watch_through.mjs`,
  bookmark: (p) => `scripts/trajectories/${p}/actions/bookmark.mjs`,
  save: (p) => `scripts/trajectories/${p}/actions/save.mjs`,
  reset_password: (p) => p === 'github' ? 'scripts/trajectories/github/recover/reset_password.mjs' : `scripts/trajectories/${p}_reset_password.mjs`,
  verify_password: (p) => p === 'microsoft' ? 'scripts/trajectories/microsoft_verify_password.mjs' : null,
  adopt_password: (p) => p === 'microsoft' ? 'scripts/trajectories/microsoft_adopt_password.mjs' : null,
  // Entra directory identities are a separate lifecycle from consumer Microsoft
  // accounts: <platform>_<verb> splits on the first underscore, so the verb here
  // is entra_adopt_password / entra_reset_password / entra_verify_password on
  // platform microsoft.
  entra_adopt_password: (p) => p === 'microsoft' ? 'scripts/trajectories/microsoft_entra_adopt_password.mjs' : null,
  entra_reset_password: (p) => p === 'microsoft' ? 'scripts/trajectories/microsoft_entra_reset_password.mjs' : null,
  entra_verify_password: (p) => p === 'microsoft' ? 'scripts/trajectories/microsoft_entra_verify_password.mjs' : null,
  balance: (p) => PROXY_PROVIDERS.has(p) ? `scripts/trajectories/${p}/balance.mjs` : `scripts/trajectories/${p}_balance.mjs`,
  topup: (p) => PROXY_PROVIDERS.has(p) ? `scripts/trajectories/${p}/topup.mjs` : null,
  analyze_text: (p) => p === 'pangram' ? 'scripts/trajectories/pangram/analyze_text.mjs' : null,
  pangram_audit_new_wniosek: (p) => p === 'ncbr' ? 'scripts/trajectories/ncbr/pangram_audit_new_wniosek.mjs' : null,
  // On-demand ticker scrape: wisent-app inserts an account_action_logs row
  // with action='unusualwhales_scrape' or 'volumeleaders_scrape' and
  // params={ticker, page}; the worker spawns the existing scrape script.
  scrape: (p) => (p === 'unusualwhales' || p === 'volumeleaders' || p === 'tradingview')
    ? `scripts/trajectories/${p}/scrape.mjs`
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

// Translate the per-row params JSON from account_action_logs into the env
// vars that the spawned trajectory subprocess reads. Pure function: no I/O,
// no shared state.
export function paramsToEnv(
  params: Record<string, unknown>,
  action: string,
  trajPath: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (trajPath.endsWith('/_shared/benign.mjs')) {
    const underscore = action.indexOf('_');
    if (underscore > 0) {
      env.PLATFORM = action.slice(0, underscore);
      env.VERB = action.slice(underscore + 1);
    }
  }
  if (trajPath.endsWith('/generic/browser_task.mjs') || trajPath.endsWith('/generic/keeper_task.mjs')) {
    const passthrough: Array<[string, string]> = [
      ['url', 'GENERIC_TASK_URL'],
      ['objective', 'GENERIC_TASK_OBJECTIVE'],
      ['flow_name', 'GENERIC_TASK_FLOW_NAME'],
      ['proxy', 'GENERIC_TASK_PROXY'],
            ['session_label', 'GENERIC_TASK_LABEL'],
            ['admin_credential_id', 'GENERIC_TASK_ADMIN_CREDENTIAL_ID'],
    ];
    for (const [key, envKey] of passthrough) {
      const value = params[key];
      if (typeof value === 'string') env[envKey] = value;
    }
    if (params.headless === true || params.headless === '1') env.GENERIC_TASK_HEADLESS = '1';
        // People-lifecycle runs reuse one seeded admin session per platform. Derive
        // the canonical WSession label + admin credential id from the platform_key
        // the payload already carries, unless the payload set them explicitly.
        const lifecycleEnv = params.env && typeof params.env === 'object' ? params.env as Record<string, unknown> : {};
        const lifecyclePlatform = typeof lifecycleEnv.platform_key === 'string' ? lifecycleEnv.platform_key : '';
        const lifecycleFlow = typeof params.flow_name === 'string' ? params.flow_name : '';
        if (lifecyclePlatform && lifecycleFlow.startsWith('people_')) {
          if (!env.GENERIC_TASK_LABEL) env.GENERIC_TASK_LABEL = `people-admin-${lifecyclePlatform}`;
          if (!env.GENERIC_TASK_ADMIN_CREDENTIAL_ID) env.GENERIC_TASK_ADMIN_CREDENTIAL_ID = `platform-admin-${lifecyclePlatform}`;
        }
    const constraints = params.constraints;
    if (constraints && typeof constraints === 'object') env.GENERIC_TASK_CONSTRAINTS = JSON.stringify(constraints);
    const taskEnv = params.env;
    if (taskEnv && typeof taskEnv === 'object') env.GENERIC_TASK_ENV = JSON.stringify(taskEnv);
  }
  if (trajPath.endsWith('/microsoft_reset_password.mjs')
      || trajPath.endsWith('/microsoft_verify_password.mjs')
      || trajPath.endsWith('/microsoft_adopt_password.mjs')
      || trajPath.endsWith('/microsoft_entra_adopt_password.mjs')
      || trajPath.endsWith('/microsoft_entra_reset_password.mjs')
      || trajPath.endsWith('/microsoft_entra_verify_password.mjs')) {
    const constraints = params.constraints;
    if (constraints && typeof constraints === 'object') {
      env.WELES_CREDENTIAL_CONSTRAINTS = JSON.stringify(constraints);
    }
  }
  if (trajPath.endsWith('/gmail/gmail_login_search.mjs')) {
    const query = params.query ?? params.q;
    if (typeof query === 'string') env.GM_QUERY = query;
    const credentialService = params.credential_service;
    if (credentialService === 'gmail' || credentialService === 'googleSso') {
      env.GM_CREDENTIAL_SERVICE = credentialService;
    }
    const max = params.max;
    if (typeof max === 'number' || typeof max === 'string') env.GM_MAX = String(max);
    if (params.open === false || params.open === 0 || params.open === '0') env.GM_OPEN = '0';
    else env.GM_OPEN = '1';
  }
  if (trajPath.endsWith('/generic/saved_task.mjs')) {
    const trajectoryId = params.trajectory_id;
    if (typeof trajectoryId === 'string') env.GENERIC_SAVED_TRAJECTORY_ID = trajectoryId;
  }
  if (trajPath.endsWith('/semanticscholar/key_followup.mjs')) {
    const sourceActionLogId = params.source_action_log_id;
    if (typeof sourceActionLogId === 'string') env.SOURCE_ACTION_LOG_ID = sourceActionLogId;
    const attempt = params.attempt;
    if (typeof attempt === 'number' || typeof attempt === 'string') env.ATTEMPT = String(attempt);
    env.SEMANTIC_SCHOLAR_TENANT_ID = typeof params.tenant_id === 'string'
      ? params.tenant_id
      : '';
  }
  if (trajPath.endsWith('/overleaf/version_history_ui_phrase.mjs')) {
    const project = params.project ?? params.overleaf_project ?? params.project_id;
    if (typeof project === 'string') env.OVERLEAF_PROJECT = project;
    const queryText = params.query_text ?? params.overleaf_query_text ?? params.phrase ?? params.overleaf_phrase;
    if (typeof queryText === 'string') {
      env.OVERLEAF_QUERY_TEXT = queryText;
      env.OVERLEAF_PHRASE = queryText;
    }
    const output = params.output_path ?? params.overleaf_output;
    if (typeof output === 'string') env.OVERLEAF_OUTPUT = output;
    const mainTex = params.main_tex ?? params.overleaf_main_tex;
    if (typeof mainTex === 'string') env.OVERLEAF_MAIN_TEX = mainTex;
    const authLabel = params.auth_label ?? params.overleaf_auth_label;
    if (typeof authLabel === 'string') env.OVERLEAF_AUTH_LABEL = authLabel;
    const maxClicks = params.max_history_clicks ?? params.overleaf_history_max_clicks;
    if (typeof maxClicks === 'number' || typeof maxClicks === 'string') env.OVERLEAF_HISTORY_MAX_CLICKS = String(maxClicks);
    if (params.persistent_profile === false || params.persistent_profile === '0') env.WELES_OVERLEAF_PERSISTENT_PROFILE = '0';
    else env.WELES_OVERLEAF_PERSISTENT_PROFILE = '1';
    env.HEADLESS = params.headless === false || params.headless === '0' ? '0' : '1';
  }
  if (trajPath.endsWith('/overleaf/push_github.mjs') || trajPath.endsWith('/overleaf/pull_github.mjs')) {
    const project = params.project ?? params.overleaf_project ?? params.project_id;
    if (typeof project === 'string') env.OVERLEAF_PROJECT = project;
    const repo = params.repo_slug ?? params.github_repo ?? params.overleaf_github_repo;
    if (typeof repo === 'string') env.OVERLEAF_GITHUB_REPO = repo;
    const message = params.commit_message ?? params.overleaf_commit_message;
    if (typeof message === 'string') env.OVERLEAF_COMMIT_MESSAGE = message;
    env.HEADLESS = params.headless === false || params.headless === '0' ? '0' : '1';
  }
  if (trajPath.endsWith('/_shared/analytics-service.mjs')) {
    const underscore = action.indexOf('_');
    if (underscore > 0) {
      env.PLATFORM = action.slice(0, underscore);
      env.VERB = action.slice(underscore + 1);
      env.SERVICE_ACTION = action;
    }
    const passthrough: Array<[string, string]> = [
      ['domain', 'DOMAIN'],
      ['email', 'EMAIL'],
      ['password', 'PASSWORD'],
      ['display_name', 'DISPLAY_NAME'],
      ['domain_or_name', 'DOMAIN_OR_NAME'],
      ['website_id', 'WEBSITE_ID'],
      ['settings_patch', 'SETTINGS_PATCH'],
      ['site_url', 'SITE_URL'],
      ['event_name', 'EVENT_NAME'],
      ['selector_or_code_path', 'SELECTOR_OR_CODE_PATH'],
      ['api_token_or_session', 'API_TOKEN_OR_SESSION'],
      ['endpoint', 'ENDPOINT'],
      ['query', 'QUERY'],
      ['report_type', 'REPORT_TYPE'],
      ['date_range', 'DATE_RANGE'],
      ['funnel_name', 'FUNNEL_NAME'],
      ['user_email', 'USER_EMAIL'],
      ['role', 'ROLE'],
      ['ga_account_id', 'GA_ACCOUNT_ID'],
      ['account_name', 'ACCOUNT_NAME'],
      ['property_id', 'PROPERTY_ID'],
      ['property_name', 'PROPERTY_NAME'],
      ['timezone', 'TIMEZONE'],
      ['currency', 'CURRENCY'],
      ['stream_id', 'STREAM_ID'],
      ['stream_name', 'STREAM_NAME'],
      ['measurement_id', 'MEASUREMENT_ID'],
      ['nickname', 'NICKNAME'],
      ['dimensions', 'DIMENSIONS'],
      ['metrics', 'METRICS'],
      ['debug_device_or_event', 'DEBUG_DEVICE_OR_EVENT'],
      ['audience_definition', 'AUDIENCE_DEFINITION'],
      ['dimension_name', 'DIMENSION_NAME'],
      ['scope', 'SCOPE'],
      ['parameter_name', 'PARAMETER_NAME'],
      ['metric_name', 'METRIC_NAME'],
      ['unit', 'UNIT'],
      ['search_console_property', 'SEARCH_CONSOLE_PROPERTY'],
      ['google_ads_customer_id', 'GOOGLE_ADS_CUSTOMER_ID'],
      ['retention_duration', 'RETENTION_DURATION'],
      ['report_name', 'REPORT_NAME'],
    ];
    for (const [key, envKey] of passthrough) {
      const value = params[key];
      if (typeof value === 'string') env[envKey] = value;
      else if (typeof value === 'number' || typeof value === 'boolean') env[envKey] = String(value);
      else if (value && typeof value === 'object') env[envKey] = JSON.stringify(value);
    }
    if (params.confirm === true || params.write_confirm === true || params.confirm === '1' || params.write_confirm === '1') {
      env.WRITE_CONFIRM = '1';
    }
  }
  // Cross-login parametric dispatch: <platform>_login_via_<provider>
  // → set PLATFORM + PROVIDER env so cross_login/run.mjs can table-lookup
  // the target URL + OAuth-button regex without one-trajectory-file-per-pair.
  if (trajPath.endsWith('/cross_login/run.mjs')) {
    const m = action.match(/^([a-z]+)_login_via_([a-z]+)$/);
    if (m) {
      env.PLATFORM = m[1];
      env.PROVIDER = m[2];
    }
  }
  if (trajPath.endsWith('/apple/ads/run.mjs')) {
    const underscore = action.indexOf('_');
    if (underscore > 0) {
      env.PLATFORM = action.slice(0, underscore);
      env.APPLE_ADS_ACTION = action.slice(underscore + 1);
    }
    if (typeof params.query === 'string') env.SEARCH_QUERY = params.query;
    if (typeof params.search_query === 'string') env.SEARCH_QUERY = params.search_query;
  }
  if (trajPath.endsWith('/apple/ads/api_client_setup_probe.mjs')) {
    if (typeof params.apple_ads_keep_open_after_login_ms === 'number') env.APPLE_ADS_KEEP_OPEN_AFTER_LOGIN_MS = String(params.apple_ads_keep_open_after_login_ms);
    if (typeof params.apple_ads_keep_open_after_login_ms === 'string') env.APPLE_ADS_KEEP_OPEN_AFTER_LOGIN_MS = params.apple_ads_keep_open_after_login_ms;
    if (params.apple_ads_close_after_probe === true || params.apple_ads_close_after_probe === '1') env.APPLE_ADS_CLOSE_AFTER_PROBE = '1';
    if (typeof params.apple_ads_diag_dir === 'string') env.APPLE_ADS_DIAG_DIR = params.apple_ads_diag_dir;
  }
  if (trajPath.endsWith('/apple/login.mjs') || trajPath.endsWith('/apple/create_developer_id.mjs')) {
    const guardId = params.apple_auth_guard_id;
    if (typeof guardId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(guardId)) {
      throw new Error('apple_auth_guard_id must be a valid UUID for apple_login');
    }
    const executionHost = params.apple_execution_host;
    const executionAgent = params.apple_execution_agent;
    if (typeof executionHost !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,251}[A-Za-z0-9])?$/.test(executionHost)) {
      throw new Error('apple_execution_host is required for apple_login');
    }
    if (typeof executionAgent !== 'string' || !/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,198}[A-Za-z0-9])?$/.test(executionAgent)) {
      throw new Error('apple_execution_agent is required for apple_login');
    }
    if (params.apple_login_capabilities === undefined) {
      throw new Error('apple_login_capabilities are required for apple_login');
    }
    env.APPLE_AUTH_GUARD_ID = guardId;
    env.APPLE_EXECUTION_HOST = executionHost;
    env.APPLE_EXECUTION_AGENT = executionAgent;
    env.APPLE_LOGIN_CAPABILITIES_JSON = JSON.stringify(
      parseAppleLoginCapabilities(params.apple_login_capabilities, guardId),
    );
    // Apple credentials and capability identifiers must never enter videos,
    // HAR/netlog, CDP dumps, page snapshots, or response-body recordings.
    env.WELES_DISABLE_RECORDING = '1';
    env.WELES_NO_RESPONSE_BODIES = '1';
    env.WELES_CHROMIUM_NETLOG = '0';
    env.WELES_FULL_DIAGNOSTICS = '0';
    env.WELES_NO_INSTRUMENT = '1';
    env.WELES_PAGE_DIAGNOSTICS = '0';
    if (trajPath.endsWith('/apple/create_developer_id.mjs')) {
      if (typeof params.apple_csr_path === 'string') env.APPLE_CSR_PATH = params.apple_csr_path;
      if (typeof params.apple_certificate_path === 'string') env.APPLE_CERTIFICATE_PATH = params.apple_certificate_path;
    }
  }
  if (trajPath.endsWith('/apple/native_2fa/run.mjs')) {
    if (typeof params.apple_2fa_code_file === 'string') env.APPLE_2FA_CODE_FILE = params.apple_2fa_code_file;
    if (typeof params.apple_2fa_wait_ms === 'number') env.APPLE_2FA_WAIT_MS = String(params.apple_2fa_wait_ms);
    if (typeof params.apple_2fa_wait_ms === 'string') env.APPLE_2FA_WAIT_MS = params.apple_2fa_wait_ms;
  }
  // Ticker-scrape parameters for the unusualwhales/volumeleaders/tradingview
  // scrape verb. Read by scrape.mjs scripts when invoked from the queue (no argv).
  if (typeof params.ticker === 'string') env.TICKER = params.ticker.toUpperCase();
  if (typeof params.page === 'string') env.PAGE = params.page;
  // `pages` is comma-separated or array; scraper loops in one Playwright session.
  if (Array.isArray(params.pages)) env.PAGES = params.pages.join(',');
  else if (typeof params.pages === 'string') env.PAGES = params.pages;
  if (typeof params.start_date === 'string') env.START_DATE = params.start_date;
  if (typeof params.end_date === 'string') env.END_DATE = params.end_date;
  if (typeof params.subreddit === 'string') env.SUBREDDIT = params.subreddit;
  if (typeof params.product_id === 'string') env.PRODUCT_ID = params.product_id;
  if (typeof params.variant === 'string') env.VARIANT = params.variant;
  if (typeof params.issue_url === 'string') env.ISSUE_URL = params.issue_url;
  if (typeof params.server_channel_path === 'string') env.SERVER_CHANNEL_PATH = params.server_channel_path;
  if (typeof params.scrolls === 'number') env.SCROLL_COUNT = String(params.scrolls);
  if (typeof params.posts_to_browse === 'number') env.SCROLL_COUNT = String(params.posts_to_browse);
  if (typeof params.search_query === 'string') env.SEARCH_QUERY = params.search_query;
  if (typeof params.pangram_text === 'string') env.PANGRAM_TEXT = params.pangram_text;
  if (typeof params.pangram_text_file === 'string') env.PANGRAM_TEXT_FILE = params.pangram_text_file;
  if (typeof params.text_file === 'string') env.TEXT_FILE = params.text_file;
  if (typeof params.pangram_analyze_url === 'string') env.PANGRAM_ANALYZE_URL = params.pangram_analyze_url;
  if (trajPath.endsWith('/overleaf/version_history_ui_phrase.mjs')) {
    env.WELES_DISABLE_RECORDING = '1';
    env.WELES_NO_RESPONSE_BODIES = '1';
    env.WELES_CHROMIUM_NETLOG = '0';
    env.WELES_FULL_DIAGNOSTICS = '0';
    env.WELES_NO_INSTRUMENT = '1';
    env.WELES_PAGE_DIAGNOSTICS = '0';
  }
  if (params.pangram_auto_register === true || params.pangram_auto_register === '1') env.PANGRAM_AUTO_REGISTER = '1';
  if (params.pangram_require_account === true || params.pangram_require_account === '1') env.PANGRAM_REQUIRE_ACCOUNT = '1';
  if (typeof params.pangram_max_account_attempts === 'number') env.PANGRAM_MAX_ACCOUNT_ATTEMPTS = String(params.pangram_max_account_attempts);
  if (typeof params.pangram_max_account_attempts === 'string') env.PANGRAM_MAX_ACCOUNT_ATTEMPTS = params.pangram_max_account_attempts;
  if (typeof params.pangram_max_auto_registers === 'number') env.PANGRAM_MAX_AUTO_REGISTERS = String(params.pangram_max_auto_registers);
  if (typeof params.pangram_max_auto_registers === 'string') env.PANGRAM_MAX_AUTO_REGISTERS = params.pangram_max_auto_registers;
  if (typeof params.pangram_register_after_credit_failures === 'number') env.PANGRAM_REGISTER_AFTER_CREDIT_FAILURES = String(params.pangram_register_after_credit_failures);
  if (typeof params.pangram_register_after_credit_failures === 'string') env.PANGRAM_REGISTER_AFTER_CREDIT_FAILURES = params.pangram_register_after_credit_failures;
  if (trajPath.endsWith('/ncbr/pangram_audit_new_wniosek.mjs')) {
    if (typeof params.ncbr_project_id === 'string') env.NCBR_PROJECT_ID = params.ncbr_project_id;
    if (typeof params.section_pattern === 'string') env.SECTION_PATTERN = params.section_pattern;
    if (typeof params.min_chars === 'number') env.MIN_CHARS = String(params.min_chars);
    if (typeof params.min_chars === 'string') env.MIN_CHARS = params.min_chars;
    if (typeof params.max_sections === 'number') env.MAX_SECTIONS = String(params.max_sections);
    if (typeof params.max_sections === 'string') env.MAX_SECTIONS = params.max_sections;
    if (params.collect_only === true || params.collect_only === '1') env.COLLECT_ONLY = '1';
    if (params.include_rows === true || params.include_rows === '1') env.INCLUDE_ROWS = '1';
    if (typeof params.pangram_analyze_timeout_ms === 'number') env.PANGRAM_ANALYZE_TIMEOUT_MS = String(params.pangram_analyze_timeout_ms);
    if (typeof params.pangram_analyze_timeout_ms === 'string') env.PANGRAM_ANALYZE_TIMEOUT_MS = params.pangram_analyze_timeout_ms;
    if (typeof params.pangram_section_timeout_ms === 'number') env.PANGRAM_SECTION_TIMEOUT_MS = String(params.pangram_section_timeout_ms);
    if (typeof params.pangram_section_timeout_ms === 'string') env.PANGRAM_SECTION_TIMEOUT_MS = params.pangram_section_timeout_ms;
  }
  // slack_post_message params: message body + where (default channel 'jakub').
  // Inline `message` is machine-independent (survives cross-host enqueue);
  // `message_file` is a path, only valid on the enqueuing machine.
  if (typeof params.message === 'string') env.MESSAGE_TEXT = params.message;
  if (typeof params.message_file === 'string') env.MESSAGE_FILE = params.message_file;
  if (typeof params.slack_channel === 'string') env.SLACK_TARGET_CHANNEL_NAME = params.slack_channel;
  if (typeof params.target_user === 'string') env.TARGET_USER = params.target_user;
  if (typeof params.target_url === 'string') env.TARGET_URL = params.target_url;
  if (typeof params.invite_url === 'string') env.INVITE_URL = params.invite_url;
  if (typeof params.repo_url === 'string') env.REPO_URL = params.repo_url;
  if (typeof params.text === 'string') env.SVC_TEXT = params.text;
  if (typeof params.slack_app_id === 'string') env.SLACK_APP_ID = params.slack_app_id;
  if (typeof params.user_token_scopes === 'string') env.SLACK_USER_TOKEN_SCOPES = params.user_token_scopes;
  // Paid ads / app store release parameters.
  for (const [k, ek] of [
    ['ad_account_id', 'AD_ACCOUNT_ID'],
    ['business_id', 'BUSINESS_ID'],
    ['ad_account_name', 'AD_ACCOUNT_NAME'],
    ['meta_ads_company_account_id', 'META_ADS_COMPANY_ACCOUNT_ID'],
    ['meta_access_token', 'META_ACCESS_TOKEN'],
    ['facebook_access_token', 'FACEBOOK_ACCESS_TOKEN'],
    ['meta_graph_api_version', 'META_GRAPH_API_VERSION'],
    ['meta_marketing_api_version', 'META_MARKETING_API_VERSION'],
    ['google_ads_developer_token', 'GOOGLE_ADS_DEVELOPER_TOKEN'],
    ['google_ads_access_token', 'GOOGLE_ADS_ACCESS_TOKEN'],
    ['resource', 'RESOURCE'],
    ['action', 'META_ACTION'],
    ['action_kind', 'ACTION_KIND'],
    ['ads_url', 'ADS_URL'],
    ['campaign_name', 'CAMPAIGN_NAME'],
    ['campaign_id', 'CAMPAIGN_ID'],
    ['campaign_objective', 'CAMPAIGN_OBJECTIVE'],
    ['campaign_destination', 'CAMPAIGN_DESTINATION'],
    ['destination_type', 'DESTINATION_TYPE'],
    ['daily_budget_usd', 'DAILY_BUDGET_USD'],
    ['lifetime_budget_usd', 'LIFETIME_BUDGET_USD'],
    ['ad_set_daily_budget_usd', 'AD_SET_DAILY_BUDGET_USD'],
    ['ad_set_lifetime_budget_usd', 'AD_SET_LIFETIME_BUDGET_USD'],
    ['date_preset', 'DATE_PRESET'],
    ['fields', 'FIELDS'],
    ['query', 'GOOGLE_ADS_QUERY'],
    ['status', 'STATUS'],
    ['destination_url', 'DESTINATION_URL'],
    ['final_url', 'FINAL_URL'],
    ['object_store_url', 'OBJECT_STORE_URL'],
    ['app_link', 'APP_LINK'],
    ['display_link', 'DISPLAY_LINK'],
    ['url_params', 'URL_PARAMS'],
    ['headline', 'HEADLINE'],
    ['headlines', 'HEADLINES'],
    ['description', 'DESCRIPTION'],
    ['descriptions', 'DESCRIPTIONS'],
    ['primary_text', 'PRIMARY_TEXT'],
    ['page_id', 'PAGE_ID'],
    ['facebook_page_name', 'FACEBOOK_PAGE_NAME'],
    ['facebook_page_id', 'FACEBOOK_PAGE_ID'],
    ['meta_facebook_page_name', 'META_FACEBOOK_PAGE_NAME'],
    ['meta_facebook_page_id', 'META_FACEBOOK_PAGE_ID'],
    ['ad_set_name', 'AD_SET_NAME'],
    ['ad_set_id', 'AD_SET_ID'],
    ['adset_id', 'ADSET_ID'],
    ['creative_id', 'CREATIVE_ID'],
    ['creative_name', 'CREATIVE_NAME'],
    ['image_hash', 'IMAGE_HASH'],
    ['image_path', 'IMAGE_PATH'],
    ['video_path', 'VIDEO_PATH'],
    ['video_title', 'VIDEO_TITLE'],
    ['call_to_action_type', 'CALL_TO_ACTION_TYPE'],
    ['object_story_spec_json', 'OBJECT_STORY_SPEC_JSON'],
    ['link_data_json', 'LINK_DATA_JSON'],
    ['asset_feed_spec_json', 'ASSET_FEED_SPEC_JSON'],
    ['template_data_json', 'TEMPLATE_DATA_JSON'],
    ['video_data_json', 'VIDEO_DATA_JSON'],
    ['child_attachments_json', 'CHILD_ATTACHMENTS_JSON'],
    ['tracking_specs_json', 'TRACKING_SPECS_JSON'],
    ['targeting_json', 'TARGETING_JSON'],
    ['geo_locations_json', 'GEO_LOCATIONS_JSON'],
    ['countries', 'COUNTRIES'],
    ['age_min', 'AGE_MIN'],
    ['age_max', 'AGE_MAX'],
    ['genders', 'GENDERS'],
    ['publisher_platforms', 'PUBLISHER_PLATFORMS'],
    ['facebook_positions', 'FACEBOOK_POSITIONS'],
    ['instagram_positions', 'INSTAGRAM_POSITIONS'],
    ['audience_network_positions', 'AUDIENCE_NETWORK_POSITIONS'],
    ['messenger_positions', 'MESSENGER_POSITIONS'],
    ['special_ad_categories', 'SPECIAL_AD_CATEGORIES'],
    ['buying_type', 'BUYING_TYPE'],
    ['bid_strategy', 'BID_STRATEGY'],
    ['bid_amount_usd', 'BID_AMOUNT_USD'],
    ['billing_event', 'BILLING_EVENT'],
    ['optimization_goal', 'OPTIMIZATION_GOAL'],
    ['start_time', 'START_TIME'],
    ['end_time', 'END_TIME'],
    ['promoted_object_json', 'PROMOTED_OBJECT_JSON'],
    ['pixel_id', 'PIXEL_ID'],
    ['custom_event_type', 'CUSTOM_EVENT_TYPE'],
    ['app_event', 'APP_EVENT'],
    ['catalog_id', 'CATALOG_ID'],
    ['product_catalog_id', 'PRODUCT_CATALOG_ID'],
    ['product_set_id', 'PRODUCT_SET_ID'],
    ['product_set_name', 'PRODUCT_SET_NAME'],
    ['product_set_filter', 'PRODUCT_SET_FILTER'],
    ['product_set_filter_json', 'PRODUCT_SET_FILTER_JSON'],
    ['catalog_name', 'CATALOG_NAME'],
    ['catalog_vertical', 'CATALOG_VERTICAL'],
    ['audience_id', 'AUDIENCE_ID'],
    ['audience_name', 'AUDIENCE_NAME'],
    ['audience_subtype', 'AUDIENCE_SUBTYPE'],
    ['audience_rule_json', 'AUDIENCE_RULE_JSON'],
    ['custom_audience_id', 'CUSTOM_AUDIENCE_ID'],
    ['custom_audiences_json', 'CUSTOM_AUDIENCES_JSON'],
    ['excluded_custom_audiences_json', 'EXCLUDED_CUSTOM_AUDIENCES_JSON'],
    ['customer_file_source', 'CUSTOMER_FILE_SOURCE'],
    ['lookalike_source_id', 'LOOKALIKE_SOURCE_ID'],
    ['lookalike_spec_json', 'LOOKALIKE_SPEC_JSON'],
    ['lookalike_country', 'LOOKALIKE_COUNTRY'],
    ['lookalike_ratio', 'LOOKALIKE_RATIO'],
    ['retention_days', 'RETENTION_DAYS'],
    ['lead_form_id', 'LEAD_FORM_ID'],
    ['form_id', 'FORM_ID'],
    ['lead_form_name', 'LEAD_FORM_NAME'],
    ['locale', 'LOCALE'],
    ['privacy_policy_url', 'PRIVACY_POLICY_URL'],
    ['privacy_policy_json', 'PRIVACY_POLICY_JSON'],
    ['questions_json', 'QUESTIONS_JSON'],
    ['context_card_json', 'CONTEXT_CARD_JSON'],
    ['thank_you_page_json', 'THANK_YOU_PAGE_JSON'],
    ['follow_up_action_url', 'FOLLOW_UP_ACTION_URL'],
    ['whatsapp_number', 'WHATSAPP_NUMBER'],
    ['live_read', 'LIVE_READ'],
    ['meta_ads_cli_args', 'META_ADS_CLI_ARGS'],
    ['browser', 'BROWSER'],
    ['ads_profile_dir', 'ADS_PROFILE_DIR'],
    ['wait_for_login', 'WAIT_FOR_LOGIN'],
    ['login_wait_ms', 'LOGIN_WAIT_MS'],
    ['date', 'DATE'],
    ['redirect_uri', 'REDIRECT_URI'],
    ['content_platform_dir', 'CONTENT_PLATFORM_DIR'],
    ['verify_account_only', 'VERIFY_ACCOUNT_ONLY'],
    ['customer_id', 'GOOGLE_ADS_CUSTOMER_ID'],
    ['login_customer_id', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID'],
    ['google_ads_customer_id', 'GOOGLE_ADS_CUSTOMER_ID'],
    ['google_ads_login_customer_id', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID'],
    ['google_ads_api_version', 'GOOGLE_ADS_API_VERSION'],
    ['update_mask', 'UPDATE_MASK'],
    ['campaign_resource_name', 'CAMPAIGN_RESOURCE_NAME'],
    ['campaign_budget_id', 'CAMPAIGN_BUDGET_ID'],
    ['campaign_budget_resource_name', 'CAMPAIGN_BUDGET_RESOURCE_NAME'],
    ['campaign_type', 'CAMPAIGN_TYPE'],
    ['ad_group_id', 'AD_GROUP_ID'],
    ['ad_group_resource_name', 'AD_GROUP_RESOURCE_NAME'],
    ['ad_group_name', 'AD_GROUP_NAME'],
    ['ad_group_status', 'AD_GROUP_STATUS'],
    ['ad_id', 'AD_ID'],
    ['ad_group_ad_resource_name', 'AD_GROUP_AD_RESOURCE_NAME'],
    ['ad_status', 'AD_STATUS'],
    ['ad_name', 'AD_NAME'],
    ['cpc_bid_usd', 'CPC_BID_USD'],
    ['validate_only', 'VALIDATE_ONLY'],
    ['network', 'NETWORK'],
    ['keywords', 'KEYWORDS'],
    ['locations', 'LOCATIONS'],
    ['app_id', 'APP_ID'],
    ['ipa_path', 'IPA_PATH'],
    ['asc_key_id', 'ASC_KEY_ID'],
    ['asc_issuer_id', 'ASC_ISSUER_ID'],
    ['asc_key_p8', 'ASC_KEY_P8'],
    ['apple_platform', 'APPLE_PLATFORM'],
    ['version_string', 'VERSION_STRING'],
    ['whats_new', 'WHATS_NEW'],
    ['build_number', 'BUILD_NUMBER'],
    ['bundle_path', 'BUNDLE_PATH'],
    ['package_name', 'PACKAGE_NAME'],
    ['play_release_url', 'PLAY_RELEASE_URL'],
    ['track', 'TRACK'],
    ['release_name', 'RELEASE_NAME'],
    ['release_notes', 'RELEASE_NOTES'],
    ['apple_ads_org_id', 'ASC_ADS_ORG_ID'],
    ['ads_org_id', 'ASC_ADS_ORG_ID'],
    ['org_id', 'ASC_ADS_ORG_ID'],
    ['org', 'ASC_ADS_ORG_ID'],
    ['apple_ads_client_id', 'ASC_ADS_CLIENT_ID'],
    ['apple_ads_team_id', 'ASC_ADS_TEAM_ID'],
    ['apple_ads_key_id', 'ASC_ADS_KEY_ID'],
    ['apple_ads_private_key_path', 'ASC_ADS_PRIVATE_KEY_PATH'],
    ['apple_ads_access_token', 'ASC_ADS_ACCESS_TOKEN'],
    ['ads_profile_name', 'APPLE_ADS_PROFILE_NAME'],
    ['ads_profile', 'APPLE_ADS_PROFILE_NAME'],
    ['adam_id', 'ADAM_ID'],
    ['country_code', 'COUNTRY_CODE'],
    ['limit', 'LIMIT'],
    ['offset', 'OFFSET'],
    ['selector', 'SELECTOR'],
    ['campaign', 'APPLE_ADS_CAMPAIGN_ID'],
    ['apple_ads_campaign_id', 'APPLE_ADS_CAMPAIGN_ID'],
    ['ad_group', 'APPLE_ADS_AD_GROUP_ID'],
    ['apple_ads_ad_group_id', 'APPLE_ADS_AD_GROUP_ID'],
    ['apple_ads_ad_id', 'APPLE_ADS_AD_ID'],
    ['keyword', 'APPLE_ADS_KEYWORD_ID'],
    ['apple_ads_keyword_id', 'APPLE_ADS_KEYWORD_ID'],
    ['creative', 'APPLE_ADS_CREATIVE_ID'],
    ['apple_ads_creative_id', 'APPLE_ADS_CREATIVE_ID'],
    ['budget_order', 'APPLE_ADS_BUDGET_ORDER_ID'],
    ['apple_ads_budget_order_id', 'APPLE_ADS_BUDGET_ORDER_ID'],
    ['report', 'APPLE_ADS_REPORT_ID'],
    ['apple_ads_report_id', 'APPLE_ADS_REPORT_ID'],
    ['reason', 'APPLE_ADS_REASON_ID'],
    ['apple_ads_reason_id', 'APPLE_ADS_REASON_ID'],
    ['method', 'APPLE_ADS_API_METHOD'],
    ['path', 'APPLE_ADS_API_PATH'],
    ['file', 'APPLE_ADS_FILE'],
    ['request_file', 'APPLE_ADS_FILE'],
    ['payload_file', 'APPLE_ADS_FILE'],
    ['report_file', 'APPLE_ADS_FILE'],
    ['payload_json', 'APPLE_ADS_PAYLOAD_JSON'],
    ['request_json', 'APPLE_ADS_PAYLOAD_JSON'],
    ['report_json', 'APPLE_ADS_PAYLOAD_JSON'],
    ['states', 'STATES'],
    ['apple_ads_cli_args', 'APPLE_ADS_CLI_ARGS'],
    ['product_page', 'APPLE_ADS_PRODUCT_PAGE_ID'],
    ['apple_ads_product_page_id', 'APPLE_ADS_PRODUCT_PAGE_ID'],
    ['from', 'APPLE_ADS_FROM'],
    ['to', 'APPLE_ADS_TO'],
    ['last_days', 'APPLE_ADS_LAST_DAYS'],
    ['level', 'APPLE_ADS_REPORT_LEVEL'],
    ['granularity', 'APPLE_ADS_GRANULARITY'],
    ['sort', 'APPLE_ADS_SORT'],
    ['time_zone', 'APPLE_ADS_TIME_ZONE'],
  ]) {
    if (typeof params[k] === 'string') env[ek] = params[k] as string;
    else if (typeof params[k] === 'number') env[ek] = String(params[k]);
    else if (typeof params[k] === 'boolean') env[ek] = params[k] ? '1' : '0';
    else if (params[k] && typeof params[k] === 'object') env[ek] = JSON.stringify(params[k]);
  }
  if (params.submit === true || params.submit === '1' || params.submit === 1) env.SUBMIT = '1';
  else if (params.submit === false || params.submit === '0' || params.submit === 0) env.SUBMIT = '0';
  if (params.apple_ads_confirm === true || params.apple_ads_confirm === '1' || params.apple_ads_confirm === 1) env.APPLE_ADS_CONFIRM = '1';
  // Capability-bootstrap override: forces a specific proxy URL into the
  // trajectory so we can test (provider, action) cells deterministically.
  // credentials.ts respects PROXY_URL_FORCE=1 to ignore stored proxy.
  if (typeof params.proxy_url_override === 'string') {
    env.PROXY_URL = params.proxy_url_override;
    env.PROXY_URL_FORCE = '1';
  }
  // Pin the email-domain rotator output to a specific domain — used by
  // domain-burn isolation experiments where the same trajectory runs N
  // times with the same IP and different domains so the matcher can
  // identify which (domain, platform) pair causes the failure.
  if (typeof params.force_email_domain === 'string') {
    env.FORCE_EMAIL_DOMAIN = params.force_email_domain;
  }
  // Service-credential topup parameters (proxy auto-topup cron). Read by
  // scripts/trajectories/_shared/services/topup_common.mjs#topupOpts.
  if (typeof params.topup_usd === 'number') env.TOPUP_USD = String(params.topup_usd);
  if (params.topup_confirm === true || params.topup_confirm === '1' || params.topup_confirm === 1) env.TOPUP_CONFIRM = '1';
  if (action.endsWith('_post_promote') || action.endsWith('_submit_promote')) env.POST_PROMOTE = '1';
  for (const [k, ek] of [['repo_name', 'REPO_NAME'], ['repo_desc', 'REPO_DESC'], ['file_path', 'FILE_PATH'], ['file_append', 'FILE_APPEND'], ['commit_message', 'COMMIT_MESSAGE'], ['issue_title', 'ISSUE_TITLE'], ['issue_body', 'ISSUE_BODY']]) {
    if (typeof params[k] === 'string') env[ek] = params[k] as string;
  }
  if (params.require_approval === true) env.REQUIRE_APPROVAL = '1';
  return env;
}
