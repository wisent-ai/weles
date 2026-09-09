// Which account a run signs in as, which task it was given, and whether the
// submission is admitted at all.
//
// This is the front of the translation: the blocks that decide the *target* of
// a run — the vault login item for a subscription sign-in, the URL/objective of
// a generic or keeper task, the credential constraints of a Microsoft password
// run, the Gmail search, the declared engagement or observation, the capture
// plan, the Semantic Scholar follow-up and the Overleaf project. It is separate
// because it changes whenever the fleet gains a new way to *name* what a run
// should act on, while the action families in the sibling modules change when a
// platform's own verbs change.
//
// Every refusal here is deliberate: a payload naming the wrong account or a
// malformed capture plan throws before anything is spawned, so the caller gets
// the exact sentence instead of a browser launched to discover the problem.

import { selectLoginAccount } from '../../utils/login-accounts.js';
import { parseAccessibilityAuditParams, parseCaptureParams } from '../capture-params.js';
import { applyDeclaredEnv } from '../declarations.js';

export function applyAccountAndTaskAdmission(
  params: Record<string, unknown>,
  trajPath: string,
  env: Record<string, string>,
): void {
  // Subscription login/reauth runs act on ONE account, and the caller names it
  // by its vault login item id — the identifier the rest of the fleet already
  // carries. It is translated here into <PROVIDER>_DISPLAY_NAME, the selector
  // those trajectories already honour, plus WELES_LOGIN_ITEM so the run reports
  // the account it was asked for. An unknown id or one belonging to another
  // provider throws, exactly as a malformed apple_login payload does: a request
  // that names the wrong account must never become a real sign-in.
  const subscriptionLogin = trajPath.match(/\/(claude|codex|kimi)\/(login|reauth)\.mjs$/);
  if (subscriptionLogin) {
    const requested = params.login_item ?? params.vault_login_item;
    if (requested !== undefined && typeof requested !== 'string') {
      throw new Error('login_item must be a vault login item id string');
    }
    if (typeof requested === 'string' && requested.trim()) {
      const account = selectLoginAccount(subscriptionLogin[1], requested);
      env.WELES_LOGIN_ITEM = account.loginItem;
      env[`${account.provider.toUpperCase()}_DISPLAY_NAME`] = account.displayName;
    }
  }
  if (trajPath.endsWith('/generic/browser_task.mjs') || trajPath.endsWith('/generic/keeper_task.mjs')) {
    const passthrough: Array<[string, string]> = [
      ['url', 'GENERIC_TASK_URL'],
      ['objective', 'GENERIC_TASK_OBJECTIVE'],
      ['flow_name', 'GENERIC_TASK_FLOW_NAME'],
      ['proxy', 'GENERIC_TASK_PROXY'],
      ['browser', 'GENERIC_TASK_BROWSER'],
      ['os', 'GENERIC_TASK_OS'],
      ['locale', 'GENERIC_TASK_LOCALE'],
            ['session_label', 'GENERIC_TASK_LABEL'],
            ['admin_credential_id', 'GENERIC_TASK_ADMIN_CREDENTIAL_ID'],
    ];
    for (const [key, envKey] of passthrough) {
      const value = params[key];
      if (typeof value === 'string') env[envKey] = value;
    }
    if (params.headless === true || params.headless === '1') env.GENERIC_TASK_HEADLESS = '1';
        // People-lifecycle runs reuse one seeded admin session per platform. Derive
        // the canonical WSession label + admin credential id from the platform_key
        // the payload already carries, unless the payload set them explicitly.
        const lifecycleEnv = params.env && typeof params.env === 'object' ? params.env as Record<string, unknown> : {};
        const lifecyclePlatform = typeof lifecycleEnv.platform_key === 'string' ? lifecycleEnv.platform_key : '';
        const lifecycleFlow = typeof params.flow_name === 'string' ? params.flow_name : '';
        if (lifecyclePlatform && lifecycleFlow.startsWith('people_')) {
          if (!env.GENERIC_TASK_LABEL) env.GENERIC_TASK_LABEL = `people-admin-${lifecyclePlatform}`;
          if (!env.GENERIC_TASK_ADMIN_CREDENTIAL_ID) env.GENERIC_TASK_ADMIN_CREDENTIAL_ID = `platform-admin-${lifecyclePlatform}`;
        }
    const constraints = params.constraints;
    if (constraints && typeof constraints === 'object') env.GENERIC_TASK_CONSTRAINTS = JSON.stringify(constraints);
    const taskEnv = params.env;
    if (taskEnv && typeof taskEnv === 'object') env.GENERIC_TASK_ENV = JSON.stringify(taskEnv);
  }
  if (trajPath.endsWith('/microsoft_reset_password.mjs')
      || trajPath.endsWith('/microsoft_verify_password.mjs')
      || trajPath.endsWith('/microsoft_adopt_password.mjs')
      || trajPath.endsWith('/microsoft_entra_adopt_password.mjs')
      || trajPath.endsWith('/microsoft_entra_reset_password.mjs')
      || trajPath.endsWith('/microsoft_entra_verify_password.mjs')) {
    const constraints = params.constraints;
    if (constraints && typeof constraints === 'object') {
      env.WELES_CREDENTIAL_CONSTRAINTS = JSON.stringify(constraints);
    }
  }
  if (trajPath.endsWith('/gmail/gmail_login_search.mjs')) {
    const query = params.query ?? params.q;
    if (typeof query === 'string') env.GM_QUERY = query;
    const credentialService = params.credential_service;
    if (credentialService === 'gmail' || credentialService === 'googleSso') {
      env.GM_CREDENTIAL_SERVICE = credentialService;
    }
    const max = params.max;
    if (typeof max === 'number' || typeof max === 'string') env.GM_MAX = String(max);
    if (params.open === false || params.open === 0 || params.open === '0') env.GM_OPEN = '0';
    else env.GM_OPEN = '1';
  }
  applyDeclaredEnv(params, trajPath, env);
  // The capture actions carry their whole instruction in params, so the
  // contract is parsed HERE: a malformed row fails at dispatch with the exact
  // refusal sentence instead of launching a browser to discover the problem.
  // The trajectory parses the same JSON again from this env var.
  if (trajPath.endsWith('/generic/capture.mjs')) {
    env.GENERIC_CAPTURE_PLAN = JSON.stringify(parseCaptureParams(params));
  }
  if (trajPath.endsWith('/generic/accessibility_audit.mjs')) {
    env.GENERIC_ACCESSIBILITY_AUDIT_PLAN = JSON.stringify(parseAccessibilityAuditParams(params));
  }
  if (trajPath.endsWith('/semanticscholar/key_followup.mjs')) {
    const sourceActionLogId = params.source_action_log_id;
    if (typeof sourceActionLogId === 'string') env.SOURCE_ACTION_LOG_ID = sourceActionLogId;
    const attempt = params.attempt;
    if (typeof attempt === 'number' || typeof attempt === 'string') env.ATTEMPT = String(attempt);
    env.SEMANTIC_SCHOLAR_TENANT_ID = typeof params.tenant_id === 'string'
      ? params.tenant_id
      : '';
  }
  if (trajPath.endsWith('/overleaf/version_history_ui_phrase.mjs')) {
    const project = params.project ?? params.overleaf_project ?? params.project_id;
    if (typeof project === 'string') env.OVERLEAF_PROJECT = project;
    const queryText = params.query_text ?? params.overleaf_query_text ?? params.phrase ?? params.overleaf_phrase;
    if (typeof queryText === 'string') {
      env.OVERLEAF_QUERY_TEXT = queryText;
      env.OVERLEAF_PHRASE = queryText;
    }
    const output = params.output_path ?? params.overleaf_output;
    if (typeof output === 'string') env.OVERLEAF_OUTPUT = output;
    const mainTex = params.main_tex ?? params.overleaf_main_tex;
    if (typeof mainTex === 'string') env.OVERLEAF_MAIN_TEX = mainTex;
    const authLabel = params.auth_label ?? params.overleaf_auth_label;
    if (typeof authLabel === 'string') env.OVERLEAF_AUTH_LABEL = authLabel;
    const maxClicks = params.max_history_clicks ?? params.overleaf_history_max_clicks;
    if (typeof maxClicks === 'number' || typeof maxClicks === 'string') env.OVERLEAF_HISTORY_MAX_CLICKS = String(maxClicks);
    if (params.persistent_profile === false || params.persistent_profile === '0') env.WELES_OVERLEAF_PERSISTENT_PROFILE = '0';
    else env.WELES_OVERLEAF_PERSISTENT_PROFILE = '1';
    env.HEADLESS = params.headless === false || params.headless === '0' ? '0' : '1';
  }
  if (trajPath.endsWith('/overleaf/push_github.mjs') || trajPath.endsWith('/overleaf/pull_github.mjs')) {
    const project = params.project ?? params.overleaf_project ?? params.project_id;
    if (typeof project === 'string') env.OVERLEAF_PROJECT = project;
    const repo = params.repo_slug ?? params.github_repo ?? params.overleaf_github_repo;
    if (typeof repo === 'string') env.OVERLEAF_GITHUB_REPO = repo;
    const message = params.commit_message ?? params.overleaf_commit_message;
    if (typeof message === 'string') env.OVERLEAF_COMMIT_MESSAGE = message;
    env.HEADLESS = params.headless === false || params.headless === '0' ? '0' : '1';
  }
}
