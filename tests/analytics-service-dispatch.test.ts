import { describe, expect, it } from 'vitest';
import { paramsToEnv, resolveTrajectory } from '../src/worker/dispatch.js';

const analyticsServicePath = 'scripts/trajectories/_shared/analytics-service.mjs';

const analyticsActions = [
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
];

describe('analytics service dispatch', () => {
  it('routes every Umami and Google Analytics action to the shared browser runner', () => {
    expect(analyticsActions).toHaveLength(52);
    for (const action of analyticsActions) {
      expect(resolveTrajectory(action), action).toBe(analyticsServicePath);
    }
  });

  it('exports platform, verb, service action, confirmation, and typed params as env', () => {
    const env = paramsToEnv(
      {
        account_name: 'NeedHer',
        property_id: 12345,
        site_url: 'https://www.needher.ai',
        measurement_id: 'G-NEEDHER',
        dimensions: ['pagePath', 'sessionSource'],
        confirm: true,
      },
      'googleanalytics_install_gtag',
      analyticsServicePath,
    );

    expect(env).toMatchObject({
      PLATFORM: 'googleanalytics',
      VERB: 'install_gtag',
      SERVICE_ACTION: 'googleanalytics_install_gtag',
      ACCOUNT_NAME: 'NeedHer',
      PROPERTY_ID: '12345',
      SITE_URL: 'https://www.needher.ai',
      MEASUREMENT_ID: 'G-NEEDHER',
      DIMENSIONS: '["pagePath","sessionSource"]',
      WRITE_CONFIRM: '1',
    });
  });
});
