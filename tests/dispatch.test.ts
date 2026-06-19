import { describe, expect, it } from 'vitest';
import { paramsToEnv, resolveTrajectory } from '../src/worker/dispatch.js';

describe('worker trajectory dispatch', () => {
  it('routes paid ads campaign trajectories', () => {
    expect(resolveTrajectory('meta_ads_campaign')).toBe('scripts/trajectories/meta/ads_campaign.mjs');
    expect(resolveTrajectory('meta_ads_login')).toBe('scripts/trajectories/meta/ads_login.mjs');
    expect(resolveTrajectory('meta_ads_cli_campaign')).toBe('scripts/trajectories/meta/ads_cli_campaign.mjs');
    expect(resolveTrajectory('meta_ads_api_campaign')).toBe('scripts/trajectories/meta/ads_api_campaign.mjs');
    expect(resolveTrajectory('meta_ads_api_catalog')).toBe('scripts/trajectories/meta/ads_api_catalog.mjs');
    expect(resolveTrajectory('meta_ads_api_audience')).toBe('scripts/trajectories/meta/ads_api_audience.mjs');
    expect(resolveTrajectory('meta_ads_api_creative')).toBe('scripts/trajectories/meta/ads_api_creative.mjs');
    expect(resolveTrajectory('meta_ads_api_lead_form')).toBe('scripts/trajectories/meta/ads_api_lead_form.mjs');
    expect(resolveTrajectory('meta_ads_api_messaging')).toBe('scripts/trajectories/meta/ads_api_messaging.mjs');
    expect(resolveTrajectory('meta_ads_performance')).toBe('scripts/trajectories/meta/ads_performance.mjs');
    expect(resolveTrajectory('meta_ads_update_campaign')).toBe('scripts/trajectories/meta/ads_update_campaign.mjs');
    expect(resolveTrajectory('google_ads_campaign')).toBe('scripts/trajectories/google/ads/ads_campaign.mjs');
    expect(resolveTrajectory('google_ads_api_campaign')).toBe('scripts/trajectories/google/ads/ads_api_campaign.mjs');
    expect(resolveTrajectory('google_ads_login')).toBe('scripts/trajectories/google/ads/ads_login.mjs');
    expect(resolveTrajectory('google_ads_performance')).toBe('scripts/trajectories/google/ads/ads_performance.mjs');
    expect(resolveTrajectory('google_ads_update_campaign')).toBe('scripts/trajectories/google/ads/ads_update_campaign.mjs');
  });

  it('routes app store submission aliases', () => {
    expect(resolveTrajectory('apple_appstore_submit')).toBe('scripts/trajectories/apple/asc/asc_submit.mjs');
    expect(resolveTrajectory('apple_appstore_analytics')).toBe('scripts/trajectories/apple/asc_analytics.mjs');
    expect(resolveTrajectory('apple_asc_submit')).toBe('scripts/trajectories/apple/asc/asc_submit.mjs');
    expect(resolveTrajectory('apple_asc_analytics')).toBe('scripts/trajectories/apple/asc_analytics.mjs');
    expect(resolveTrajectory('google_appstore_submit')).toBe('scripts/trajectories/google/play/play_submit.mjs');
    expect(resolveTrajectory('google_play_submit')).toBe('scripts/trajectories/google/play/play_submit.mjs');
  });

  it('routes Apple Ads management trajectories', () => {
    const appleAdsRunner = 'scripts/trajectories/apple/ads/run.mjs';
    for (const action of [
      'apple_ads_cli',
      'apple_ads_auth_status',
      'apple_ads_auth_doctor',
      'apple_ads_auth_login',
      'apple_ads_auth_discover',
      'apple_ads_auth_token',
      'apple_ads_auth_switch',
      'apple_ads_auth_logout',
      'apple_ads_me',
      'apple_ads_acls',
      'apple_ads_apps_search',
      'apple_ads_apps_view',
      'apple_ads_apps_localized_details',
      'apple_ads_apps_assets_find',
      'apple_ads_apps_eligibility_find',
      'apple_ads_product_pages',
      'apple_ads_product_page_view',
      'apple_ads_product_page_countries',
      'apple_ads_product_page_devices',
      'apple_ads_product_page_locales',
      'apple_ads_creatives',
      'apple_ads_creative_find',
      'apple_ads_creative_create',
      'apple_ads_creative_view',
      'apple_ads_geo_search',
      'apple_ads_geo_resolve',
      'apple_ads_campaigns',
      'apple_ads_campaign_find',
      'apple_ads_campaign_view',
      'apple_ads_campaign_create',
      'apple_ads_campaign_update',
      'apple_ads_campaign_delete',
      'apple_ads_campaign_pause',
      'apple_ads_campaign_resume',
      'apple_ads_ad_groups',
      'apple_ads_ad_group_find',
      'apple_ads_ad_group_find_org',
      'apple_ads_ad_group_view',
      'apple_ads_ad_group_create',
      'apple_ads_ad_group_update',
      'apple_ads_ad_group_delete',
      'apple_ads_ads',
      'apple_ads_ad_find',
      'apple_ads_ad_find_org',
      'apple_ads_ad_view',
      'apple_ads_ad_create',
      'apple_ads_ad_update',
      'apple_ads_ad_delete',
      'apple_ads_keywords',
      'apple_ads_keyword_find',
      'apple_ads_keyword_view',
      'apple_ads_keyword_delete',
      'apple_ads_keywords_create_bulk',
      'apple_ads_keywords_update_bulk',
      'apple_ads_keywords_delete_bulk',
      'apple_ads_negative_keywords',
      'apple_ads_negative_keyword_find',
      'apple_ads_negative_keyword_view',
      'apple_ads_negative_keywords_create_bulk',
      'apple_ads_negative_keywords_update_bulk',
      'apple_ads_negative_keywords_delete_bulk',
      'apple_ads_ad_group_negative_keywords',
      'apple_ads_ad_group_negative_keyword_find',
      'apple_ads_ad_group_negative_keyword_view',
      'apple_ads_ad_group_negative_keywords_create_bulk',
      'apple_ads_ad_group_negative_keywords_update_bulk',
      'apple_ads_ad_group_negative_keywords_delete_bulk',
      'apple_ads_reports_campaigns',
      'apple_ads_reports_ad_groups',
      'apple_ads_reports_ads',
      'apple_ads_reports_keywords',
      'apple_ads_reports_search_terms',
      'apple_ads_reports_ad_group_keywords',
      'apple_ads_reports_ad_group_search_terms',
      'apple_ads_reports_preset',
      'apple_ads_impression_share_reports',
      'apple_ads_impression_share_report_create',
      'apple_ads_impression_share_report_view',
      'apple_ads_budget_orders',
      'apple_ads_budget_order_create',
      'apple_ads_budget_order_update',
      'apple_ads_budget_order_view',
      'apple_ads_rejection_reasons',
      'apple_ads_rejection_reason_view',
      'apple_ads_api_request',
    ]) {
      expect(resolveTrajectory(action)).toBe(appleAdsRunner);
    }
  });

  it('maps Apple Ads params into trajectory env', () => {
    const env = paramsToEnv({
      org_id: '123456',
      ads_profile: 'Marketing',
      apple_ads_client_id: 'SEARCHADS.client',
      apple_ads_team_id: 'TEAMID',
      apple_ads_key_id: 'KEYID',
      apple_ads_private_key_path: '/tmp/apple-ads.pem',
      adam_id: 6450000000,
      query: 'Wisent',
      campaign: 987654321,
      ad_group: 123456789,
      apple_ads_ad_id: 222,
      keyword: 333,
      budget_order: 444,
      report: 555,
      reason: 666,
      country_code: 'US',
      limit: 25,
      payload_json: { data: [{ id: 'kw1' }] },
      apple_ads_cli_args: 'ads campaigns --limit 1',
      product_page: 'default-product-page',
      from: '2026-06-05',
      to: '2026-06-12',
      last_days: 7,
      level: 'campaigns',
      granularity: 'DAILY',
      sort: '-impressions',
      time_zone: 'UTC',
      method: 'POST',
      path: 'v5/campaigns/find',
      apple_ads_confirm: true,
    }, 'apple_ads_api_request', 'scripts/trajectories/apple/ads/run.mjs');

    expect(env.APPLE_ADS_ACTION).toBe('ads_api_request');
    expect(env.ASC_ADS_ORG_ID).toBe('123456');
    expect(env.APPLE_ADS_PROFILE_NAME).toBe('Marketing');
    expect(env.ASC_ADS_CLIENT_ID).toBe('SEARCHADS.client');
    expect(env.ASC_ADS_TEAM_ID).toBe('TEAMID');
    expect(env.ASC_ADS_KEY_ID).toBe('KEYID');
    expect(env.ASC_ADS_PRIVATE_KEY_PATH).toBe('/tmp/apple-ads.pem');
    expect(env.ADAM_ID).toBe('6450000000');
    expect(env.GOOGLE_ADS_QUERY).toBe('Wisent');
    expect(env.SEARCH_QUERY).toBe('Wisent');
    expect(env.APPLE_ADS_CAMPAIGN_ID).toBe('987654321');
    expect(env.APPLE_ADS_AD_GROUP_ID).toBe('123456789');
    expect(env.APPLE_ADS_AD_ID).toBe('222');
    expect(env.APPLE_ADS_KEYWORD_ID).toBe('333');
    expect(env.APPLE_ADS_BUDGET_ORDER_ID).toBe('444');
    expect(env.APPLE_ADS_REPORT_ID).toBe('555');
    expect(env.APPLE_ADS_REASON_ID).toBe('666');
    expect(env.COUNTRY_CODE).toBe('US');
    expect(env.LIMIT).toBe('25');
    expect(env.APPLE_ADS_PAYLOAD_JSON).toBe('{"data":[{"id":"kw1"}]}');
    expect(env.APPLE_ADS_CLI_ARGS).toBe('ads campaigns --limit 1');
    expect(env.APPLE_ADS_PRODUCT_PAGE_ID).toBe('default-product-page');
    expect(env.APPLE_ADS_FROM).toBe('2026-06-05');
    expect(env.APPLE_ADS_TO).toBe('2026-06-12');
    expect(env.APPLE_ADS_LAST_DAYS).toBe('7');
    expect(env.APPLE_ADS_REPORT_LEVEL).toBe('campaigns');
    expect(env.APPLE_ADS_GRANULARITY).toBe('DAILY');
    expect(env.APPLE_ADS_SORT).toBe('-impressions');
    expect(env.APPLE_ADS_TIME_ZONE).toBe('UTC');
    expect(env.APPLE_ADS_API_METHOD).toBe('POST');
    expect(env.APPLE_ADS_API_PATH).toBe('v5/campaigns/find');
    expect(env.APPLE_ADS_CONFIRM).toBe('1');
  });

  it('maps paid ads and app store params into trajectory env', () => {
    const env = paramsToEnv({
      ad_account_id: 'act_123',
      business_id: 'biz_456',
      ad_account_name: 'Wisent',
      meta_ads_company_account_id: '849988068092449',
      resource: 'stack',
      action: 'create',
      campaign_id: '456',
      campaign_name: 'Launch',
      campaign_objective: 'Traffic',
      campaign_destination: 'website',
      meta_ads_cli_args: 'ads campaign list --output json',
      daily_budget_usd: 25,
      date_preset: 'LAST_30_DAYS',
      fields: 'spend,clicks',
      query: 'SELECT campaign.id FROM campaign LIMIT 1',
      status: 'PAUSED',
      destination_url: 'https://example.com',
      display_link: 'example.com',
      url_params: 'utm_source=meta',
      headline: 'Hello',
      headlines: 'A|B|C',
      description: 'Desc',
      descriptions: 'D1|D2',
      primary_text: 'Primary',
      meta_facebook_page_name: 'Wisent',
      meta_facebook_page_id: '832900009911874',
      ad_set_name: 'Launch ad set',
      ad_name: 'Launch ad',
      targeting_json: '{"geo_locations":{"countries":["US"]}}',
      publisher_platforms: 'facebook,instagram',
      facebook_positions: 'feed,story',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      optimization_goal: 'LINK_CLICKS',
      billing_event: 'IMPRESSIONS',
      product_set_id: 'ps_123',
      catalog_id: 'cat_123',
      custom_audience_id: 'aud_123',
      lead_form_id: 'form_123',
      whatsapp_number: '15555550100',
      customer_id: '111-222-3333',
      login_customer_id: '999-888-7777',
      google_ads_api_version: 'v24',
      update_mask: 'name,status',
      campaign_budget_id: '777',
      ad_group_id: '888',
      ad_group_name: 'Launch ad group',
      ad_group_status: 'PAUSED',
      ad_id: '999',
      ad_status: 'PAUSED',
      cpc_bid_usd: 1.25,
      validate_only: '1',
      keywords: 'alpha,beta',
      app_id: '6450000000',
      ipa_path: '/tmp/app.ipa',
      bundle_path: '/tmp/app.aab',
      package_name: 'com.example.app',
      submit: false,
    }, 'meta_ads_campaign', 'scripts/trajectories/meta/ads_campaign.mjs');

    expect(env.AD_ACCOUNT_ID).toBe('act_123');
    expect(env.BUSINESS_ID).toBe('biz_456');
    expect(env.AD_ACCOUNT_NAME).toBe('Wisent');
    expect(env.META_ADS_COMPANY_ACCOUNT_ID).toBe('849988068092449');
    expect(env.RESOURCE).toBe('stack');
    expect(env.META_ACTION).toBe('create');
    expect(env.CAMPAIGN_ID).toBe('456');
    expect(env.CAMPAIGN_NAME).toBe('Launch');
    expect(env.CAMPAIGN_OBJECTIVE).toBe('Traffic');
    expect(env.CAMPAIGN_DESTINATION).toBe('website');
    expect(env.META_ADS_CLI_ARGS).toBe('ads campaign list --output json');
    expect(env.DAILY_BUDGET_USD).toBe('25');
    expect(env.DATE_PRESET).toBe('LAST_30_DAYS');
    expect(env.FIELDS).toBe('spend,clicks');
    expect(env.GOOGLE_ADS_QUERY).toBe('SELECT campaign.id FROM campaign LIMIT 1');
    expect(env.STATUS).toBe('PAUSED');
    expect(env.DESTINATION_URL).toBe('https://example.com');
    expect(env.DISPLAY_LINK).toBe('example.com');
    expect(env.URL_PARAMS).toBe('utm_source=meta');
    expect(env.HEADLINE).toBe('Hello');
    expect(env.HEADLINES).toBe('A|B|C');
    expect(env.DESCRIPTION).toBe('Desc');
    expect(env.DESCRIPTIONS).toBe('D1|D2');
    expect(env.PRIMARY_TEXT).toBe('Primary');
    expect(env.META_FACEBOOK_PAGE_NAME).toBe('Wisent');
    expect(env.META_FACEBOOK_PAGE_ID).toBe('832900009911874');
    expect(env.AD_SET_NAME).toBe('Launch ad set');
    expect(env.AD_NAME).toBe('Launch ad');
    expect(env.TARGETING_JSON).toBe('{"geo_locations":{"countries":["US"]}}');
    expect(env.PUBLISHER_PLATFORMS).toBe('facebook,instagram');
    expect(env.FACEBOOK_POSITIONS).toBe('feed,story');
    expect(env.BID_STRATEGY).toBe('LOWEST_COST_WITHOUT_CAP');
    expect(env.OPTIMIZATION_GOAL).toBe('LINK_CLICKS');
    expect(env.BILLING_EVENT).toBe('IMPRESSIONS');
    expect(env.PRODUCT_SET_ID).toBe('ps_123');
    expect(env.CATALOG_ID).toBe('cat_123');
    expect(env.CUSTOM_AUDIENCE_ID).toBe('aud_123');
    expect(env.LEAD_FORM_ID).toBe('form_123');
    expect(env.WHATSAPP_NUMBER).toBe('15555550100');
    expect(env.GOOGLE_ADS_CUSTOMER_ID).toBe('111-222-3333');
    expect(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID).toBe('999-888-7777');
    expect(env.GOOGLE_ADS_API_VERSION).toBe('v24');
    expect(env.UPDATE_MASK).toBe('name,status');
    expect(env.CAMPAIGN_BUDGET_ID).toBe('777');
    expect(env.AD_GROUP_ID).toBe('888');
    expect(env.AD_GROUP_NAME).toBe('Launch ad group');
    expect(env.AD_GROUP_STATUS).toBe('PAUSED');
    expect(env.AD_ID).toBe('999');
    expect(env.AD_STATUS).toBe('PAUSED');
    expect(env.CPC_BID_USD).toBe('1.25');
    expect(env.VALIDATE_ONLY).toBe('1');
    expect(env.KEYWORDS).toBe('alpha,beta');
    expect(env.APP_ID).toBe('6450000000');
    expect(env.IPA_PATH).toBe('/tmp/app.ipa');
    expect(env.BUNDLE_PATH).toBe('/tmp/app.aab');
    expect(env.PACKAGE_NAME).toBe('com.example.app');
    expect(env.SUBMIT).toBe('0');
  });
});
