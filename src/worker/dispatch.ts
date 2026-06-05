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

const benignPath = 'scripts/trajectories/_shared/benign.mjs';

const PROXY_PROVIDERS = new Set([
  'iproyal', 'packetstream', 'brightdata', 'oxylabs',
  'anticaptcha', 'capmonster', 'capsolver', 'twocaptcha', 'nopecha',
  'sadcaptcha', 'pingproxies', 'juicysms', 'fivesim',
]);

const ROUTES: Record<string, (p: string) => string | null> = {
  // Generic surface ticks dispatch to the benign runner which reads PLATFORM/VERB env.
  dwell: () => benignPath, notifications: () => benignPath, search: () => benignPath, profile_view: () => benignPath,

  browse: (p) => p === 'github' ? 'scripts/trajectories/github/actions/browse.mjs' : `scripts/trajectories/${p}/browse.mjs`,
  health: (p) => p === 'github' ? 'scripts/trajectories/github/health/run.mjs' : `scripts/trajectories/${p}/health.mjs`,
  // Infra maintenance verbs (not social-account actions): resend_verify_domain_status
  // re-verifies stale inbound domains + confirms real receiving (no browser).
  verify_domain_status: (p) => `scripts/trajectories/${p}/verify_domain_status.mjs`,
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
    if (p === 'apple' || p === 'microsoft') return `scripts/trajectories/${p}/login.mjs`;
    if (p === 'facebook' || p === 'threads') return `scripts/trajectories/meta/${p}_login.mjs`;
    return `scripts/trajectories/${p}_login.mjs`;
  },
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
  balance: (p) => PROXY_PROVIDERS.has(p) ? `scripts/trajectories/${p}/balance.mjs` : `scripts/trajectories/${p}_balance.mjs`,
  topup: (p) => PROXY_PROVIDERS.has(p) ? `scripts/trajectories/${p}/topup.mjs` : null,
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
  if (typeof params.target_user === 'string') env.TARGET_USER = params.target_user;
  if (typeof params.target_url === 'string') env.TARGET_URL = params.target_url;
  if (typeof params.invite_url === 'string') env.INVITE_URL = params.invite_url;
  if (typeof params.repo_url === 'string') env.REPO_URL = params.repo_url;
  if (typeof params.text === 'string') env.SVC_TEXT = params.text;
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
