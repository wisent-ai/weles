// The `asc ads` arguments for every Apple Ads action Weles dispatches.
import { action, org, appendPaging, ensureCliArgsAllowed, ensureConfirmed, payloadFile, reportPresetArgs, requireValue, requireValueFrom, splitArgs, value, withOptional, withOrg } from './args.mjs';

export async function argsForAction() {
  if (process.env.APPLE_ADS_CLI_ARGS) {
    const args = splitArgs(process.env.APPLE_ADS_CLI_ARGS);
    ensureCliArgsAllowed(args);
    return args;
  }

  const campaign = () => requireValue('APPLE_ADS_CAMPAIGN_ID', 'campaign/apple_ads_campaign_id');
  const adGroup = () => requireValue('APPLE_ADS_AD_GROUP_ID', 'ad_group/apple_ads_ad_group_id');
  const ad = () => requireValue('APPLE_ADS_AD_ID', 'apple_ads_ad_id');
  const keyword = () => requireValue('APPLE_ADS_KEYWORD_ID', 'keyword/apple_ads_keyword_id');
  const budgetOrder = () => requireValue('APPLE_ADS_BUDGET_ORDER_ID', 'budget_order/apple_ads_budget_order_id');
  const report = () => requireValue('APPLE_ADS_REPORT_ID', 'report/apple_ads_report_id');
  const reason = () => requireValue('APPLE_ADS_REASON_ID', 'reason/apple_ads_reason_id');
  const productPage = () => requireValue('APPLE_ADS_PRODUCT_PAGE_ID', 'product_page/apple_ads_product_page_id');
  const file = async () => requireValueFrom(await payloadFile(), 'file/request_file/payload_json');
  const requestFile = async () => requireValueFrom(await payloadFile(), 'file/report_file/report_json');

  switch (action) {
    case 'ads_cli':
      console.log('FAIL: apple_ads_cli requires apple_ads_cli_args');
      process.exit(1);
    case 'ads_auth_status':
      return ['ads', 'auth', 'status', '--validate'];
    case 'ads_auth_doctor':
      return ['ads', 'auth', 'doctor'];
    case 'ads_auth_discover':
      return withOrg(['ads', 'auth', 'discover']);
    case 'ads_auth_token':
      ensureConfirmed('print a sensitive Apple Ads access token');
      return withOrg(['ads', 'auth', 'token', '--confirm']);
    case 'ads_auth_switch':
      return ['ads', 'auth', 'switch', '--name', requireValue('APPLE_ADS_PROFILE_NAME', 'ads_profile/ads_profile_name')];
    case 'ads_auth_logout':
      ensureConfirmed('remove stored Apple Ads credentials');
      return ['ads', 'auth', 'logout', '--name', requireValue('APPLE_ADS_PROFILE_NAME', 'ads_profile/ads_profile_name')];
    case 'ads_auth_login': {
      ensureConfirmed('write stored Apple Ads credentials');
      const args = ['ads', 'auth', 'login'];
      const name = value('APPLE_ADS_PROFILE_NAME');
      return [
        ...args,
        ...(name ? ['--name', name] : []),
        '--client-id', requireValue('ASC_ADS_CLIENT_ID'),
        '--team-id', requireValue('ASC_ADS_TEAM_ID'),
        '--key-id', requireValue('ASC_ADS_KEY_ID'),
        '--private-key', requireValue('ASC_ADS_PRIVATE_KEY_PATH'),
        ...(org ? ['--org', org] : []),
        ...(process.env.NETWORK === '1' || process.env.NETWORK === 'true' ? ['--network'] : []),
      ];
    }
    case 'ads_me':
      return ['ads', 'me', 'view'];
    case 'ads_acls':
      return ['ads', 'acls'];
    case 'ads_apps_search':
      return appendPaging(withOrg(['ads', 'apps', 'search', '--query', requireValue('SEARCH_QUERY', 'query/search_query')]));
    case 'ads_apps_view':
      return withOrg(['ads', 'apps', 'view', '--adam-id', requireValue('ADAM_ID', 'adam_id')]);
    case 'ads_apps_localized_details':
      return withOrg(['ads', 'apps', 'localized-details', '--adam-id', requireValue('ADAM_ID', 'adam_id')]);
    case 'ads_apps_assets_find':
      return withOrg(['ads', 'apps', 'assets', 'find', '--adam-id', requireValue('ADAM_ID', 'adam_id'), '--file', await file()]);
    case 'ads_apps_eligibility_find':
      return withOrg(['ads', 'apps', 'eligibility', 'find', '--adam-id', requireValue('ADAM_ID', 'adam_id'), '--file', await file()]);
    case 'ads_product_pages': {
      let args = withOrg(['ads', 'product-pages', 'list', '--adam-id', requireValue('ADAM_ID', 'adam_id')]);
      args = withOptional(args, '--states', 'STATES');
      return appendPaging(args);
    }
    case 'ads_product_page_view':
      return withOrg(['ads', 'product-pages', 'view', '--adam-id', requireValue('ADAM_ID', 'adam_id'), '--product-page', productPage()]);
    case 'ads_product_page_countries':
      return withOrg(['ads', 'product-pages', 'countries', 'list', '--adam-id', requireValue('ADAM_ID', 'adam_id')]);
    case 'ads_product_page_devices':
      return withOrg(['ads', 'product-pages', 'devices', 'list', '--adam-id', requireValue('ADAM_ID', 'adam_id')]);
    case 'ads_product_page_locales':
      return withOrg(['ads', 'product-pages', 'locales', 'list', '--adam-id', requireValue('ADAM_ID', 'adam_id')]);
    case 'ads_creatives':
      return appendPaging(withOrg(['ads', 'creatives', 'list']));
    case 'ads_creative_find':
      return withOrg(['ads', 'creatives', 'find', '--file', await file()]);
    case 'ads_creative_create':
      ensureConfirmed('create an Apple Ads creative');
      return withOrg(['ads', 'creatives', 'create', '--file', await file()]);
    case 'ads_creative_view': {
      let args = withOrg(['ads', 'creatives', 'view', '--creative', requireValue('APPLE_ADS_CREATIVE_ID', 'creative/apple_ads_creative_id')]);
      if (process.env.INCLUDE_DELETED_CREATIVE_SET_ASSETS === '1') args.push('--include-deleted-creative-set-assets');
      return args;
    }
    case 'ads_geo_search': {
      let args = withOrg(['ads', 'geo', 'search', '--query', requireValue('SEARCH_QUERY', 'query/search_query')]);
      args = withOptional(args, '--country-code', 'COUNTRY_CODE');
      return appendPaging(args);
    }
    case 'ads_geo_resolve':
      return appendPaging(withOrg(['ads', 'geo', 'resolve', '--file', await file()]));
    case 'ads_campaigns':
      return appendPaging(withOrg(['ads', 'campaigns']));
    case 'ads_campaign_find':
      return withOrg(['ads', 'campaigns', 'find', '--file', await file()]);
    case 'ads_campaign_view':
      return withOrg(['ads', 'campaigns', 'view', '--campaign', campaign()]);
    case 'ads_campaign_create':
      ensureConfirmed('create an Apple Ads campaign');
      return withOrg(['ads', 'campaigns', 'create', '--file', await file()]);
    case 'ads_campaign_update':
      ensureConfirmed('update an Apple Ads campaign');
      return withOrg(['ads', 'campaigns', 'update', '--campaign', campaign(), '--file', await file()]);
    case 'ads_campaign_delete':
      ensureConfirmed('delete an Apple Ads campaign');
      return withOrg(['ads', 'campaigns', 'delete', '--campaign', campaign(), '--confirm']);
    case 'ads_campaign_pause':
      ensureConfirmed('pause an Apple Ads campaign');
      return withOrg(['ads', 'campaigns', 'pause', '--campaign', campaign()]);
    case 'ads_campaign_resume':
      ensureConfirmed('resume an Apple Ads campaign');
      return withOrg(['ads', 'campaigns', 'resume', '--campaign', campaign()]);
    case 'ads_ad_groups':
      return appendPaging(withOrg(['ads', 'ad-groups', 'list', '--campaign', campaign()]));
    case 'ads_ad_group_find':
      return withOrg(['ads', 'ad-groups', 'find', '--campaign', campaign(), '--file', await file()]);
    case 'ads_ad_group_find_org':
      return withOrg(['ads', 'ad-groups', 'find-org', '--file', await file()]);
    case 'ads_ad_group_view':
      return withOrg(['ads', 'ad-groups', 'view', '--campaign', campaign(), '--ad-group', adGroup()]);
    case 'ads_ad_group_create':
      ensureConfirmed('create an Apple Ads ad group');
      return withOrg(['ads', 'ad-groups', 'create', '--campaign', campaign(), '--file', await file()]);
    case 'ads_ad_group_update':
      ensureConfirmed('update an Apple Ads ad group');
      return withOrg(['ads', 'ad-groups', 'update', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await file()]);
    case 'ads_ad_group_delete':
      ensureConfirmed('delete an Apple Ads ad group');
      return withOrg(['ads', 'ad-groups', 'delete', '--campaign', campaign(), '--ad-group', adGroup(), '--confirm']);
    case 'ads_ads':
      return appendPaging(withOrg(['ads', 'ads', 'list', '--campaign', campaign(), '--ad-group', adGroup()]));
    case 'ads_ad_find':
      return withOrg(['ads', 'ads', 'find', '--campaign', campaign(), '--file', await file()]);
    case 'ads_ad_find_org':
      return withOrg(['ads', 'ads', 'find-org', '--file', await file()]);
    case 'ads_ad_view':
      return withOrg(['ads', 'ads', 'view', '--campaign', campaign(), '--ad-group', adGroup(), '--ad', ad()]);
    case 'ads_ad_create':
      ensureConfirmed('create an Apple Ads ad');
      return withOrg(['ads', 'ads', 'create', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await file()]);
    case 'ads_ad_update':
      ensureConfirmed('update an Apple Ads ad');
      return withOrg(['ads', 'ads', 'update', '--campaign', campaign(), '--ad-group', adGroup(), '--ad', ad(), '--file', await file()]);
    case 'ads_ad_delete':
      ensureConfirmed('delete an Apple Ads ad');
      return withOrg(['ads', 'ads', 'delete', '--campaign', campaign(), '--ad-group', adGroup(), '--ad', ad(), '--confirm']);
    case 'ads_keywords':
      return appendPaging(withOrg(['ads', 'targeting-keywords', 'list', '--campaign', campaign(), '--ad-group', adGroup()]));
    case 'ads_keyword_find':
      return withOrg(['ads', 'targeting-keywords', 'find', '--campaign', campaign(), '--file', await file()]);
    case 'ads_keyword_view':
      return withOrg(['ads', 'targeting-keywords', 'view', '--campaign', campaign(), '--ad-group', adGroup(), '--keyword', keyword()]);
    case 'ads_keyword_delete':
      ensureConfirmed('delete an Apple Ads targeting keyword');
      return withOrg(['ads', 'targeting-keywords', 'delete', '--campaign', campaign(), '--ad-group', adGroup(), '--keyword', keyword(), '--confirm']);
    case 'ads_keywords_create_bulk':
      ensureConfirmed('create Apple Ads targeting keywords');
      return withOrg(['ads', 'targeting-keywords', 'create-bulk', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await file()]);
    case 'ads_keywords_update_bulk':
      ensureConfirmed('update Apple Ads targeting keywords');
      return withOrg(['ads', 'targeting-keywords', 'update-bulk', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await file()]);
    case 'ads_keywords_delete_bulk':
      ensureConfirmed('delete Apple Ads targeting keywords');
      return withOrg(['ads', 'targeting-keywords', 'delete-bulk', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await file(), '--confirm']);
    case 'ads_negative_keywords':
      return appendPaging(withOrg(['ads', 'campaign-negative-keywords', 'list', '--campaign', campaign()]));
    case 'ads_negative_keyword_find':
      return withOrg(['ads', 'campaign-negative-keywords', 'find', '--campaign', campaign(), '--file', await file()]);
    case 'ads_negative_keyword_view':
      return withOrg(['ads', 'campaign-negative-keywords', 'view', '--campaign', campaign(), '--keyword', keyword()]);
    case 'ads_negative_keywords_create_bulk':
      ensureConfirmed('create Apple Ads negative keywords');
      return withOrg(['ads', 'campaign-negative-keywords', 'create-bulk', '--campaign', campaign(), '--file', await file()]);
    case 'ads_negative_keywords_update_bulk':
      ensureConfirmed('update Apple Ads negative keywords');
      return withOrg(['ads', 'campaign-negative-keywords', 'update-bulk', '--campaign', campaign(), '--file', await file()]);
    case 'ads_negative_keywords_delete_bulk':
      ensureConfirmed('delete Apple Ads negative keywords');
      return withOrg(['ads', 'campaign-negative-keywords', 'delete-bulk', '--campaign', campaign(), '--file', await file(), '--confirm']);
    case 'ads_ad_group_negative_keywords':
      return appendPaging(withOrg(['ads', 'ad-group-negative-keywords', 'list', '--campaign', campaign(), '--ad-group', adGroup()]));
    case 'ads_ad_group_negative_keyword_find':
      return withOrg(['ads', 'ad-group-negative-keywords', 'find', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await file()]);
    case 'ads_ad_group_negative_keyword_view':
      return withOrg(['ads', 'ad-group-negative-keywords', 'view', '--campaign', campaign(), '--ad-group', adGroup(), '--keyword', keyword()]);
    case 'ads_ad_group_negative_keywords_create_bulk':
      ensureConfirmed('create Apple Ads ad group negative keywords');
      return withOrg(['ads', 'ad-group-negative-keywords', 'create-bulk', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await file()]);
    case 'ads_ad_group_negative_keywords_update_bulk':
      ensureConfirmed('update Apple Ads ad group negative keywords');
      return withOrg(['ads', 'ad-group-negative-keywords', 'update-bulk', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await file()]);
    case 'ads_ad_group_negative_keywords_delete_bulk':
      ensureConfirmed('delete Apple Ads ad group negative keywords');
      return withOrg(['ads', 'ad-group-negative-keywords', 'delete-bulk', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await file(), '--confirm']);
    case 'ads_reports_campaigns':
      return withOrg(['ads', 'reports', 'campaigns', '--file', await requestFile()]);
    case 'ads_reports_ad_groups':
      return withOrg(['ads', 'reports', 'ad-groups', '--campaign', campaign(), '--file', await requestFile()]);
    case 'ads_reports_ads':
      return withOrg(['ads', 'reports', 'ads', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await requestFile()]);
    case 'ads_reports_keywords':
      return withOrg(['ads', 'reports', 'keywords', '--campaign', campaign(), '--file', await requestFile()]);
    case 'ads_reports_search_terms':
      return withOrg(['ads', 'reports', 'search-terms', '--campaign', campaign(), '--file', await requestFile()]);
    case 'ads_reports_ad_group_keywords':
      return withOrg(['ads', 'reports', 'ad-group-keywords', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await requestFile()]);
    case 'ads_reports_ad_group_search_terms':
      return withOrg(['ads', 'reports', 'ad-group-search-terms', '--campaign', campaign(), '--ad-group', adGroup(), '--file', await requestFile()]);
    case 'ads_reports_preset':
      return reportPresetArgs();
    case 'ads_impression_share_report':
    case 'ads_impression_share_reports':
      return appendPaging(withOrg(['ads', 'impression-share-reports', 'list']));
    case 'ads_impression_share_report_create':
      ensureConfirmed('create an Apple Ads impression share report');
      return withOrg(['ads', 'impression-share-reports', 'create', '--file', await requestFile()]);
    case 'ads_impression_share_report_view':
      return withOrg(['ads', 'impression-share-reports', 'view', '--report', report()]);
    case 'ads_budget_orders':
      return appendPaging(withOrg(['ads', 'budget-orders', 'list']));
    case 'ads_budget_order_create':
      ensureConfirmed('create an Apple Ads budget order');
      return withOrg(['ads', 'budget-orders', 'create', '--file', await file()]);
    case 'ads_budget_order_update':
      ensureConfirmed('update an Apple Ads budget order');
      return withOrg(['ads', 'budget-orders', 'update', '--budget-order', budgetOrder(), '--file', await file()]);
    case 'ads_budget_order_view':
      return withOrg(['ads', 'budget-orders', 'view', '--budget-order', budgetOrder()]);
    case 'ads_rejection_reasons':
      return withOrg(['ads', 'rejection-reasons', 'find', '--file', await requestFile()]);
    case 'ads_rejection_reason_view':
      return withOrg(['ads', 'rejection-reasons', 'view', '--reason', reason()]);
    case 'ads_api_request': {
      const method = value('APPLE_ADS_API_METHOD', 'GET').toUpperCase();
      if (method !== 'GET') ensureConfirmed(`send a raw ${method} Apple Ads API request`);
      const f = await payloadFile();
      return withOrg([
        'ads', 'api', 'request',
        '--method', method,
        '--path', requireValue('APPLE_ADS_API_PATH', 'path'),
        ...(f ? ['--file', f] : []),
        ...(method === 'DELETE' ? ['--confirm'] : []),
      ]);
    }
    default:
      console.log(`FAIL: unsupported Apple Ads action ${action}`);
      process.exit(1);
  }
}

