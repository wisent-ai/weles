// What the Apple family of actions must prove before a sign-in starts, and
// what it is allowed to leave behind.
//
// Apple Ads runs are parametric on the action name, and apple/login.mjs and
// apple/create_developer_id.mjs are the strictest submissions in the fleet:
// guard id, execution host, execution agent, declared capabilities and an
// Apple Skarbiec account item are all required, and the run is forced into a
// no-recording, no-response-body, no-netlog mode so credentials and capability
// identifiers cannot leak into evidence.
//
// It is separate because it changes for exactly one reason: Apple's sign-in and
// evidence requirements move. That is a different reason to change than the
// tabular-verb dispatch in ./action-name-dispatch.ts, which moves when a new
// analytics platform or OAuth provider pair is added without a new trajectory.

import { parseAppleLoginCapabilities } from '../../utils/apple-login-capabilities.js';

export function applyAppleActionParams(
  params: Record<string, unknown>,
  action: string,
  trajPath: string,
  env: Record<string, string>,
): void {
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
    // The account the run signs in as. Both Apple trajectories refuse without
    // it — `WELES_LOGIN_ITEM must name an Apple account` — and nothing set it
    // for them: the only two places that assign WELES_LOGIN_ITEM are the
    // subscription-login paths for claude, codex and kimi. So neither
    // apple/login.mjs nor apple/create_developer_id.mjs has ever been able to
    // start, on the queue path or through the API, however correct the caller
    // was. Stado has been sending the item all along under `account_item`,
    // which nothing read.
    const appleAccount = params.login_item ?? params.account_item;
    if (typeof appleAccount !== 'string' || !/^weles-apple-[a-z0-9][a-z0-9-]{0,126}-account$/.test(appleAccount)) {
      throw new Error('login_item must name an Apple Skarbiec account item for an apple trajectory');
    }
    env.WELES_LOGIN_ITEM = appleAccount;
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
}
