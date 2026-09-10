// The actions described by their content rather than by their trajectory: what
// is being scraped, what text is being audited, what message is being posted.
//
// Ticker/date/page scrape parameters, the Pangram detector knobs, the NCBR
// wniosek audit and correction runs, and the Slack/GitHub message payload. Most
// of these are set unconditionally, because the same payload key means the same
// thing to every scraper that reads it — which is precisely why they belong
// together and away from the trajectory-gated blocks.
//
// This module changes when a scraper, a text audit or an outbound message gains
// a new field.

export function applyContentActionParams(
  params: Record<string, unknown>,
  action: string,
  trajPath: string,
  env: Record<string, string>,
): void {
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
  if (trajPath.endsWith('/ncbr/apply_correction.mjs')) {
    if (typeof params.objective === 'string') env.NCBR_CORRECTION_PLAN = params.objective;
    env.NCBR_CORRECTION_MODE = action === 'ncbr_apply_correction' ? 'apply' : 'verify';
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
}
