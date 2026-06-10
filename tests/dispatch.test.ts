import { describe, expect, it } from 'vitest';
import { paramsToEnv, resolveTrajectory } from '../src/worker/dispatch.js';

describe('worker trajectory dispatch', () => {
  it('routes paid ads campaign trajectories', () => {
    expect(resolveTrajectory('meta_ads_campaign')).toBe('scripts/trajectories/meta/ads_campaign.mjs');
    expect(resolveTrajectory('meta_ads_login')).toBe('scripts/trajectories/meta/ads_login.mjs');
    expect(resolveTrajectory('meta_ads_cli_campaign')).toBe('scripts/trajectories/meta/ads_cli_campaign.mjs');
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

  it('maps paid ads and app store params into trajectory env', () => {
    const env = paramsToEnv({
      ad_account_id: 'act_123',
      business_id: 'biz_456',
      ad_account_name: 'Wisent',
      meta_ads_company_account_id: '849988068092449',
      campaign_id: '456',
      campaign_name: 'Launch',
      campaign_objective: 'Traffic',
      meta_ads_cli_args: 'ads campaign list --output json',
      daily_budget_usd: 25,
      date_preset: 'LAST_30_DAYS',
      fields: 'spend,clicks',
      query: 'SELECT campaign.id FROM campaign LIMIT 1',
      status: 'PAUSED',
      destination_url: 'https://example.com',
      headline: 'Hello',
      headlines: 'A|B|C',
      description: 'Desc',
      descriptions: 'D1|D2',
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
    expect(env.CAMPAIGN_ID).toBe('456');
    expect(env.CAMPAIGN_NAME).toBe('Launch');
    expect(env.CAMPAIGN_OBJECTIVE).toBe('Traffic');
    expect(env.META_ADS_CLI_ARGS).toBe('ads campaign list --output json');
    expect(env.DAILY_BUDGET_USD).toBe('25');
    expect(env.DATE_PRESET).toBe('LAST_30_DAYS');
    expect(env.FIELDS).toBe('spend,clicks');
    expect(env.GOOGLE_ADS_QUERY).toBe('SELECT campaign.id FROM campaign LIMIT 1');
    expect(env.STATUS).toBe('PAUSED');
    expect(env.DESTINATION_URL).toBe('https://example.com');
    expect(env.HEADLINE).toBe('Hello');
    expect(env.HEADLINES).toBe('A|B|C');
    expect(env.DESCRIPTION).toBe('Desc');
    expect(env.DESCRIPTIONS).toBe('D1|D2');
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
    expect(env.KEYWORDS).toBe('alpha,beta');
    expect(env.APP_ID).toBe('6450000000');
    expect(env.IPA_PATH).toBe('/tmp/app.ipa');
    expect(env.BUNDLE_PATH).toBe('/tmp/app.aab');
    expect(env.PACKAGE_NAME).toBe('com.example.app');
    expect(env.SUBMIT).toBe('0');
  });
});
