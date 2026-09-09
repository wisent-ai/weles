// How the action name itself becomes env for the table-driven trajectories.
//
// The analytics-service family and the cross-login family share one program per
// family and one parametric verb table inside it: the run learns which platform
// and which verb it is from PLATFORM/VERB/SERVICE_ACTION or PLATFORM/PROVIDER,
// not from a trajectory file of its own. Everything here therefore reads
// `action`, not just `params`.
//
// It is separate because it changes for exactly one reason: a new tabular verb
// arrives — another analytics platform, another OAuth provider pair — and no
// new trajectory file is written. That is a different reason to change than the
// Apple requirements in ./apple-actions.ts, which move when Apple's sign-in and
// evidence rules move.

export function applyActionNameDispatch(
  params: Record<string, unknown>,
  action: string,
  trajPath: string,
  env: Record<string, string>,
): void {
  if (trajPath.endsWith('/_shared/analytics-service.mjs')) {
    const underscore = action.indexOf('_');
    if (underscore > 0) {
      env.PLATFORM = action.slice(0, underscore);
      env.VERB = action.slice(underscore + 1);
      env.SERVICE_ACTION = action;
    }
    const passthrough: Array<[string, string]> = [
      ['domain', 'DOMAIN'],
      ['email', 'EMAIL'],
      ['password', 'PASSWORD'],
      ['display_name', 'DISPLAY_NAME'],
      ['domain_or_name', 'DOMAIN_OR_NAME'],
      ['website_id', 'WEBSITE_ID'],
      ['settings_patch', 'SETTINGS_PATCH'],
      ['site_url', 'SITE_URL'],
      ['event_name', 'EVENT_NAME'],
      ['selector_or_code_path', 'SELECTOR_OR_CODE_PATH'],
      ['api_token_or_session', 'API_TOKEN_OR_SESSION'],
      ['endpoint', 'ENDPOINT'],
      ['query', 'QUERY'],
      ['report_type', 'REPORT_TYPE'],
      ['date_range', 'DATE_RANGE'],
      ['funnel_name', 'FUNNEL_NAME'],
      ['user_email', 'USER_EMAIL'],
      ['role', 'ROLE'],
      ['ga_account_id', 'GA_ACCOUNT_ID'],
      ['account_name', 'ACCOUNT_NAME'],
      ['property_id', 'PROPERTY_ID'],
      ['property_name', 'PROPERTY_NAME'],
      ['timezone', 'TIMEZONE'],
      ['currency', 'CURRENCY'],
      ['stream_id', 'STREAM_ID'],
      ['stream_name', 'STREAM_NAME'],
      ['measurement_id', 'MEASUREMENT_ID'],
      ['nickname', 'NICKNAME'],
      ['dimensions', 'DIMENSIONS'],
      ['metrics', 'METRICS'],
      ['debug_device_or_event', 'DEBUG_DEVICE_OR_EVENT'],
      ['audience_definition', 'AUDIENCE_DEFINITION'],
      ['dimension_name', 'DIMENSION_NAME'],
      ['scope', 'SCOPE'],
      ['parameter_name', 'PARAMETER_NAME'],
      ['metric_name', 'METRIC_NAME'],
      ['unit', 'UNIT'],
      ['search_console_property', 'SEARCH_CONSOLE_PROPERTY'],
      ['google_ads_customer_id', 'GOOGLE_ADS_CUSTOMER_ID'],
      ['retention_duration', 'RETENTION_DURATION'],
      ['report_name', 'REPORT_NAME'],
    ];
    for (const [key, envKey] of passthrough) {
      const value = params[key];
      if (typeof value === 'string') env[envKey] = value;
      else if (typeof value === 'number' || typeof value === 'boolean') env[envKey] = String(value);
      else if (value && typeof value === 'object') env[envKey] = JSON.stringify(value);
    }
    if (params.confirm === true || params.write_confirm === true || params.confirm === '1' || params.write_confirm === '1') {
      env.WRITE_CONFIRM = '1';
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
}
