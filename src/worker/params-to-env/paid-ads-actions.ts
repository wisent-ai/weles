// Which campaign, creative, audience and store-release fields reach the paid
// advertising and app-publishing runs.
//
// Meta, Google Ads, Apple Search Ads and the App Store / Play release verbs all
// speak one flat vocabulary of payload keys, and each one has a fixed env name
// the trajectory and the CLI wrappers already read. The table below is that
// vocabulary; the loop after it is the only conversion rule (string as-is,
// number stringified, boolean as 1/0, object as JSON).
//
// It is separate because it is the part that grows with every new ad object,
// targeting field or release attribute, and it grows by one row at a time — a
// churn that has nothing to do with how a run is admitted or which account it
// signs in as. The write-guards at the end (SUBMIT, APPLE_ADS_CONFIRM,
// TOPUP_CONFIRM, REQUIRE_APPROVAL) live here for the same reason: they gate the
// spending verbs this vocabulary describes.

export function applyPaidAdsActionParams(
  params: Record<string, unknown>,
  action: string,
  env: Record<string, string>,
): void {
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
  if (typeof params.proxy_filter === 'string') {
    env.PROXY_URL = params.proxy_filter;
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
  // src/trajectories/_shared/services/topup_common.mjs#topupOpts.
  if (typeof params.topup_usd === 'number') env.TOPUP_USD = String(params.topup_usd);
  if (params.topup_confirm === true || params.topup_confirm === '1' || params.topup_confirm === 1) env.TOPUP_CONFIRM = '1';
  if (action.endsWith('_submit_promote')) env.POST_PROMOTE = '1';
  for (const [k, ek] of [['repo_name', 'REPO_NAME'], ['repo_desc', 'REPO_DESC'], ['file_path', 'FILE_PATH'], ['file_append', 'FILE_APPEND'], ['commit_message', 'COMMIT_MESSAGE'], ['issue_title', 'ISSUE_TITLE'], ['issue_body', 'ISSUE_BODY']]) {
    if (typeof params[k] === 'string') env[ek] = params[k] as string;
  }
  if (params.require_approval === true) env.REQUIRE_APPROVAL = '1';
}
