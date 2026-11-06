#!/usr/bin/env node
// Provision a Slack User OAuth Token (xoxp) through the signed-in workspace.
//
// Env:
//   SLACK_WORKSPACE_URL          required: the workspace, https://<name>.slack.com
//   WELES_CREDENTIAL_CONSTRAINTS required: the Skarbiec item the token is stored
//                                in (the worker passes a run's `constraints`);
//                                the token is captured from the app's OAuth page
//                                and written by the session's credential store,
//                                never as text anywhere else
//   PROXY_URL                    required: the proxy the browser goes through,
//                                or 'direct'
//   SLACK_EMAIL, SLACK_PASS      sign in through the workspace's Google SSO;
//                                unset, the browser must already hold the
//                                workspace's session
//   SLACK_WEB_USER_TOKEN         the web client's xoxc token, with
//   SLACK_WEB_COOKIE_D           its session cookie, instead of reading the
//                                signed-in client's own
//   SLACK_APP_ID                 read the token of this existing app
//   SLACK_USER_TOKEN_APP_NAME    required when an app is created: its name
//   SLACK_USER_TOKEN_SCOPES      required when an app is created: the user
//                                scopes it is granted (comma or space separated)
//
// The scopes reported are the ones Slack says the token holds (auth.test's
// x-oauth-scopes header), not the ones asked for. Stdout carries only the
// token's type and length.

// The token goes only to the Skarbiec item a run names.
import { statedText } from '../_shared/inputs/stated.mjs';
import {
  appToken,
  installManifestApp,
  statedManifest,
} from './steps/manifest_app.mjs';
import {
  readClientToken,
  seatApiSession,
  signInThroughGoogle,
  slackWorkspace,
  startSlackSession,
  statedSlackLogin,
} from './steps/workspace.mjs';

const LABEL = 'slack-user-token';
const workspace = slackWorkspace();
statedText(
  ['WELES_CREDENTIAL_CONSTRAINTS'],
  "the Skarbiec item the user token is stored in (a run's constraints, passed by the worker)",
);
const APP_ID = process.env.SLACK_APP_ID;
// The app is named and granted before the browser starts, so a run that would
// create one nobody described is refused before anything happens.
const manifest = APP_ID
  ? null
  : statedManifest({
      kind: 'user',
      nameVar: 'SLACK_USER_TOKEN_APP_NAME',
      scopesVar: 'SLACK_USER_TOKEN_SCOPES',
      what: 'user-token',
    });
const STATED_CLIENT = process.env.SLACK_WEB_USER_TOKEN;
const login = statedSlackLogin();

/** The caller's xoxc token, its session cookie seated in the browser. */
async function seatStatedClient(page) {
  await page.context().addCookies([
    {
      name: 'd',
      value: statedText(
        ['SLACK_WEB_COOKIE_D'],
        'the Slack session cookie (d) that goes with SLACK_WEB_USER_TOKEN',
      ),
      domain: '.slack.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'None',
    },
  ]);
  return STATED_CLIENT;
}

const { s, shot } = await startSlackSession(LABEL);
try {
  const statedXoxc = STATED_CLIENT ? await seatStatedClient(s.page) : null;
  await signInThroughGoogle(s, workspace, login, LABEL);
  await seatApiSession(s.page, workspace);

  let appId = APP_ID;
  if (!appId) {
    const xoxc = statedXoxc
      ? statedXoxc
      : await readClientToken(s.page, workspace);
    appId = await installManifestApp({
      page: s.page,
      xoxc,
      manifest,
      label: LABEL,
      shot,
    });
  }
  const token = await appToken(s.page, appId, 'xoxp');

  const authRes = await s.page
    .context()
    .request.post('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${token}` },
    });
  const auth = await authRes.json();
  if (!auth.ok)
    throw new Error(
      `SLACK_TOKEN_REFUSED: auth.test refused the xoxp token of app ${appId}: ${auth.error}`,
    );
  const granted = authRes.headers()['x-oauth-scopes'];
  if (!granted)
    throw new Error(
      `SLACK_TOKEN_SCOPES_UNREAD: auth.test answered no x-oauth-scopes header for app ${appId}`,
    );

  const report = {
    app_id: appId,
    app_created: !APP_ID,
    scopes: granted.split(','),
    team: auth.team,
    team_id: auth.team_id,
    user: auth.user,
    user_id: auth.user_id,
    url: auth.url,
  };
  // The browser is still on the app's OAuth page, where the store captures it.
  const stored = await s.storeCredential('User OAuth Token', 'token');
  console.log(
    `[${LABEL}] ready ${JSON.stringify({ type: token.split('-').shift(), length: token.length, ...report, stored })}`,
  );
} finally {
  await s.close();
}
