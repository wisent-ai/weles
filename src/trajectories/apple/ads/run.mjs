// Apple Ads trajectory runner backed by `asc ads`.
//
// Weles action names use `apple_<verb>`, where APPLE_ADS_ACTION is the verb
// parsed by dispatch.ts, e.g. `ads_campaigns` or `ads_reports_keywords`.
//
// Mutations are intentionally gated: create/update/delete/auth-login/raw
// non-GET requests require APPLE_ADS_CONFIRM=1, WRITE_CONFIRM=1, or SUBMIT=1.

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const ASC_BIN = process.env.ASC_BIN || 'asc';
const action = process.env.APPLE_ADS_ACTION || 'ads_campaigns';
const org = process.env.ASC_ADS_ORG_ID;
const adsProfile = process.env.APPLE_ADS_PROFILE_NAME;
const confirmed = process.env.APPLE_ADS_CONFIRM === '1'
  || process.env.WRITE_CONFIRM === '1'
  || process.env.SUBMIT === '1';

function value(name, fallback = undefined) {
  const v = process.env[name];
  return v == null || v === '' ? fallback : v;
}

function requireValue(name, label = name) {
  const v = value(name);
  if (!v) {
    console.log(`FAIL: ${label} is required for ${action}`);
    process.exit(1);
  }
  return v;
}

function withOrg(args) {
  let out = args;
  if (org) out = [...out, '--org', org];
  if (adsProfile) out = [...out, '--ads-profile', adsProfile];
  return out;
}

function withOutput(args) {
  if (process.env.APPLE_ADS_NO_OUTPUT === '1') return args;
  if (args[0] === 'ads' && args[1] === 'auth' && ['login', 'logout', 'switch'].includes(args[2])) return args;
  return args.includes('--output') ? args : [...args, '--output', 'json'];
}

function withOptional(args, flag, envName) {
  const v = value(envName);
  return v ? [...args, flag, v] : args;
}

function appendPaging(args) {
  let out = args;
  out = withOptional(out, '--limit', 'LIMIT');
  out = withOptional(out, '--offset', 'OFFSET');
  if (process.env.PAGINATE === '1') out = [...out, '--paginate'];
  return out;
}

async function payloadFile() {
  const existing = value('APPLE_ADS_FILE');
  if (existing) return existing;
  const json = value('APPLE_ADS_PAYLOAD_JSON');
  if (!json) return null;
  const dir = await mkdtemp(join(tmpdir(), 'weles-apple-ads-'));
  const file = join(dir, 'request.json');
  await writeFile(file, json);
  return file;
}

function splitArgs(s) {
  if (!s) return [];
  const out = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === '\\' && i + 1 < s.length) {
        i += 1;
        cur += s[i];
      } else cur += ch;
    } else if (ch === '"' || ch === "'") q = ch;
    else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else cur += ch;
  }
  if (q) throw new Error('APPLE_ADS_CLI_ARGS has an unterminated quote');
  if (cur) out.push(cur);
  return out;
}

function ensureConfirmed(kind) {
  if (!confirmed) {
    console.log(`FAIL: ${action} would ${kind}; set apple_ads_confirm=true, write_confirm=true, or submit=true in params to proceed.`);
    process.exit(2);
  }
}

function ensureCliArgsAllowed(args) {
  const joined = args.join(' ').toLowerCase();
  const mutating = /\b(create|update|delete|pause|resume|login|logout|token)\b/.test(joined)
    || (/\brequest\b/.test(joined) && /\b--method\s+(post|put|patch|delete)\b/.test(joined));
  if (mutating) ensureConfirmed(`run mutating/sensitive asc args: ${args.join(' ')}`);
}

function reportPresetArgs() {
  let args = ['ads', 'reports', 'preset'];
  args = withOptional(args, '--level', 'APPLE_ADS_REPORT_LEVEL');
  args = withOptional(args, '--from', 'APPLE_ADS_FROM');
  args = withOptional(args, '--to', 'APPLE_ADS_TO');
  args = withOptional(args, '--last-days', 'APPLE_ADS_LAST_DAYS');
  args = withOptional(args, '--fields', 'FIELDS');
  args = withOptional(args, '--sort', 'APPLE_ADS_SORT');
  args = withOptional(args, '--granularity', 'APPLE_ADS_GRANULARITY');
  args = withOptional(args, '--time-zone', 'APPLE_ADS_TIME_ZONE');
  args = withOptional(args, '--campaign', 'APPLE_ADS_CAMPAIGN_ID');
  args = withOptional(args, '--ad-group', 'APPLE_ADS_AD_GROUP_ID');
  args = withOptional(args, '--limit', 'LIMIT');
  args = withOptional(args, '--offset', 'OFFSET');
  if (process.env.RETURN_ROW_TOTALS === '1' || process.env.RETURN_ROW_TOTALS === 'true') args.push('--return-row-totals');
  return withOrg(args);
}

async function argsForAction() {
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

function requireValueFrom(v, label) {
  if (!v) {
    console.log(`FAIL: ${label} is required for ${action}`);
    process.exit(1);
  }
  return v;
}

function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ASC_BIN, withOutput(args), { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

const args = await argsForAction();
console.log(`[apple-ads] ${ASC_BIN} ${withOutput(args).map((a) => /\s/.test(a) ? JSON.stringify(a) : a).join(' ')}`);

const result = await run(args);
if (result.out) console.log(result.out.trim().slice(0, 30000));
if (result.err) console.error(result.err.trim().slice(0, 4000));
if (result.code !== 0) {
  console.log(`FAIL: asc ads exited ${result.code}`);
  process.exit(result.code || 1);
}

console.log(`PASS: Apple Ads ${action} completed`);
