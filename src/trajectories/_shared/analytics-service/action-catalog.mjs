const UMAMI_BASE = 'https://cloud.umami.is';
const UMAMI_APP_BASE = `${UMAMI_BASE}/analytics/us`;
const GA_BASE = 'https://analytics.google.com/analytics/web/';

const ACTIONS = {
  umami_register: { platform: 'umami', risk: 'admin', url: `${UMAMI_BASE}/signup`, required: ['EMAIL', 'PASSWORD'], objective: 'Register a new Umami Cloud account.' },
  umami_login: { platform: 'umami', risk: 'verify', url: UMAMI_BASE, required: [], objective: 'Verify the Umami browser session is authenticated.' },
  umami_create_website: { platform: 'umami', risk: 'write', url: `${UMAMI_APP_BASE}/websites`, required: ['DOMAIN', 'DISPLAY_NAME'], objective: 'Create an Umami website entry.' },
  umami_find_website: { platform: 'umami', risk: 'read', url: `${UMAMI_APP_BASE}/websites`, required: ['DOMAIN_OR_NAME'], objective: 'Find an Umami website row by domain or name.' },
  umami_get_website_id: { platform: 'umami', risk: 'read', url: `${UMAMI_APP_BASE}/websites`, required: ['DOMAIN_OR_NAME'], objective: 'Read the Umami website id.' },
  umami_get_tracking_snippet: { platform: 'umami', risk: 'read', url: () => `${UMAMI_APP_BASE}/websites/${input('WEBSITE_ID')}/settings`, required: ['WEBSITE_ID'], objective: 'Read the Umami tracking snippet.' },
  umami_update_website_settings: { platform: 'umami', risk: 'write', url: `${UMAMI_APP_BASE}/websites`, required: ['WEBSITE_ID', 'SETTINGS_PATCH'], objective: 'Update Umami website settings.' },
  umami_verify_tracking_script: { platform: 'umami', risk: 'verify', url: () => input('SITE_URL', 'https://www.needher.ai'), required: ['SITE_URL', 'WEBSITE_ID'], objective: 'Verify the target site serves the expected Umami script.' },
  umami_verify_realtime_event: { platform: 'umami', risk: 'verify', url: UMAMI_BASE, required: ['SITE_URL', 'WEBSITE_ID'], objective: 'Verify a visit can appear in Umami realtime analytics.' },
  umami_view_realtime: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID'], objective: 'Open Umami realtime analytics.' },
  umami_view_summary: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami summary metrics.' },
  umami_view_pages: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami page performance.' },
  umami_view_referrers: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami referrers.' },
  umami_view_events: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami events.' },
  umami_track_custom_event: { platform: 'umami', risk: 'verify', url: () => input('SITE_URL', 'https://www.needher.ai'), required: ['SITE_URL', 'EVENT_NAME'], objective: 'Trigger or verify a custom Umami event on the target site.' },
  umami_view_sessions: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami sessions.' },
  umami_create_report: { platform: 'umami', risk: 'write', url: UMAMI_BASE, required: ['WEBSITE_ID', 'REPORT_TYPE', 'DATE_RANGE'], objective: 'Create an Umami report.' },
  umami_view_funnels: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'FUNNEL_NAME', 'DATE_RANGE'], objective: 'Read Umami funnel performance.' },
  umami_view_goals: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami goals.' },
  umami_view_user_journeys: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami user journeys.' },
  umami_view_retention: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami retention.' },
  umami_view_cohorts: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami cohorts.' },
  umami_view_utm_campaigns: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Read Umami UTM campaign performance.' },
  umami_api_query: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['ENDPOINT', 'QUERY'], objective: 'Open Umami and capture browser-session context for an API query.' },
  umami_create_share_url: { platform: 'umami', risk: 'admin', url: `${UMAMI_APP_BASE}/websites`, required: ['WEBSITE_ID'], objective: 'Create or copy an Umami share URL.' },
  umami_manage_user_access: { platform: 'umami', risk: 'admin', url: `${UMAMI_BASE}/settings`, required: ['WEBSITE_ID', 'USER_EMAIL', 'ROLE'], objective: 'Manage Umami user access.' },
  umami_export_report: { platform: 'umami', risk: 'read', url: UMAMI_BASE, required: ['WEBSITE_ID', 'DATE_RANGE'], objective: 'Export or capture an Umami report.' },

  googleanalytics_register: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['ACCOUNT_NAME', 'PROPERTY_NAME', 'SITE_URL', 'STREAM_NAME'], objective: 'Create a GA4 account, property, and web stream from scratch.' },
  googleanalytics_register_needher: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: [], objective: 'Create the NeedHer GA4 account, property, and web stream from scratch.' },
  googleanalytics_login: { platform: 'googleanalytics', risk: 'verify', url: GA_BASE, required: [], objective: 'Verify the Google Analytics browser session is authenticated.' },
  googleanalytics_find_property: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['DOMAIN_OR_NAME'], objective: 'Find a GA4 property.' },
  googleanalytics_create_account: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['ACCOUNT_NAME'], objective: 'Create a Google Analytics account container.' },
  googleanalytics_create_property: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_NAME', 'TIMEZONE', 'CURRENCY'], objective: 'Create a GA4 property.' },
  googleanalytics_create_web_stream: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'SITE_URL', 'STREAM_NAME'], objective: 'Create a GA4 web data stream.' },
  googleanalytics_get_measurement_id: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID'], objective: 'Read the GA4 measurement id.' },
  googleanalytics_get_global_site_tag: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID'], objective: 'Read the Google tag snippet.' },
  googleanalytics_create_measurement_protocol_secret: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'STREAM_ID', 'NICKNAME'], objective: 'Create a Measurement Protocol API secret.' },
  googleanalytics_install_gtag: { platform: 'googleanalytics', risk: 'verify', url: () => input('SITE_URL', 'https://www.needher.ai'), required: ['SITE_URL', 'MEASUREMENT_ID'], objective: 'Verify a target app serves the GA4 tag.' },
  googleanalytics_verify_realtime: { platform: 'googleanalytics', risk: 'verify', url: GA_BASE, required: ['SITE_URL', 'MEASUREMENT_ID'], objective: 'Verify GA4 realtime tracking.' },
  googleanalytics_view_debugview: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DEBUG_DEVICE_OR_EVENT'], objective: 'Open GA4 DebugView.' },
  googleanalytics_view_realtime: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID'], objective: 'Open GA4 realtime analytics.' },
  googleanalytics_run_data_api_report: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DIMENSIONS', 'METRICS', 'DATE_RANGE'], objective: 'Run or stage a GA4 report by dimensions and metrics.' },
  googleanalytics_view_acquisition: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DATE_RANGE'], objective: 'Read GA4 acquisition reports.' },
  googleanalytics_view_engagement: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DATE_RANGE'], objective: 'Read GA4 engagement reports.' },
  googleanalytics_view_pages: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DATE_RANGE'], objective: 'Read GA4 pages and screens.' },
  googleanalytics_create_key_event: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'EVENT_NAME'], objective: 'Create or mark a GA4 key event.' },
  googleanalytics_view_key_events: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'DATE_RANGE'], objective: 'Read GA4 key events.' },
  googleanalytics_create_audience: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'AUDIENCE_DEFINITION'], objective: 'Create a GA4 audience.' },
  googleanalytics_create_custom_dimension: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'DIMENSION_NAME', 'SCOPE', 'PARAMETER_NAME'], objective: 'Create a GA4 custom dimension.' },
  googleanalytics_create_custom_metric: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'METRIC_NAME', 'PARAMETER_NAME', 'UNIT'], objective: 'Create a GA4 custom metric.' },
  googleanalytics_link_search_console: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'SEARCH_CONSOLE_PROPERTY'], objective: 'Link Search Console to GA4.' },
  googleanalytics_link_google_ads: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'GOOGLE_ADS_CUSTOMER_ID'], objective: 'Link Google Ads to GA4.' },
  googleanalytics_update_data_retention: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'RETENTION_DURATION'], objective: 'Read or update GA4 retention settings.' },
  googleanalytics_add_user: { platform: 'googleanalytics', risk: 'admin', url: GA_BASE, required: ['PROPERTY_ID', 'USER_EMAIL', 'ROLE'], objective: 'Grant a user GA access.' },
  googleanalytics_export_report: { platform: 'googleanalytics', risk: 'read', url: GA_BASE, required: ['PROPERTY_ID', 'REPORT_NAME', 'DATE_RANGE'], objective: 'Export or capture a GA4 report.' },
};

function input(name, whenUnset = '') {
  return process.env[name] || whenUnset;
}

function defaultInput(name, declaredDefault) {
  const value = input(name);
  return value || declaredDefault;
}

function siteHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  }
}

function siteHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
}

function actionName() {
  if (process.env.SERVICE_ACTION) return process.env.SERVICE_ACTION;
  if (process.env.ACTION) return process.env.ACTION;
  if (process.env.PLATFORM && process.env.VERB) return `${process.env.PLATFORM}_${process.env.VERB}`;
  return '';
}

function actionUrl(cfg) {
  return typeof cfg.url === 'function' ? cfg.url() : cfg.url;
}

function missingInputs(cfg) {
  return cfg.required.filter((key) => !process.env[key]);
}

export {
  UMAMI_BASE,
  UMAMI_APP_BASE,
  GA_BASE,
  ACTIONS,
  input,
  defaultInput,
  siteHost,
  siteHostname,
  actionName,
  actionUrl,
  missingInputs,
};
