// Create a Slack bot app in a workspace and store its bot (xoxb) token in
// Skarbiec.
//
// Env:
//   SLACK_WORKSPACE_URL          required: the workspace, https://<name>.slack.com
//   SLACK_BOT_APP_NAME           required: the name the workspace lists the app under
//   SLACK_BOT_SCOPES             required: the bot scopes it is granted (comma or
//                                space separated)
//   WELES_CREDENTIAL_CONSTRAINTS required: the Skarbiec item the token is stored in
//                                (the worker passes a run's `constraints`); the
//                                token is captured from the app's OAuth page by the
//                                session's credential store and never leaves it
//                                as text
//   PROXY_URL                    required: the proxy the browser goes through, or 'direct'
//   SLACK_EMAIL, SLACK_PASS      sign in through the workspace's Google SSO; unset,
//                                the browser must already hold the workspace's session
//
// Stdout carries only the token's type and length and what the store answered.

import { statedText } from '../_shared/inputs/stated.mjs';
import { botManifest, createBotApp } from './steps/create_bot_app.mjs';
import {
  readClientToken,
  seatApiSession,
  signInThroughGoogle,
  slackWorkspace,
  startSlackSession,
  statedSlackLogin,
} from './steps/workspace.mjs';

const LABEL = 'slack-create';
const workspace = slackWorkspace();
const manifest = botManifest();
// The token goes only to the Skarbiec item a run names, so a run that names
// none is refused before the browser starts.
statedText(
  ['WELES_CREDENTIAL_CONSTRAINTS'],
  "the Skarbiec item the bot token is stored in (a run's constraints, passed by the worker)",
);
const login = statedSlackLogin();

const { s, shot } = await startSlackSession(LABEL);
try {
  await signInThroughGoogle(s, workspace, login, LABEL);
  const xoxc = await readClientToken(s.page, workspace);
  await seatApiSession(s.page, workspace);
  const { appId, token } = await createBotApp({
    page: s.page,
    xoxc,
    manifest,
    shot,
  });

  const auth = await (
    await s.page.context().request.post('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${token}` },
    })
  ).json();
  if (!auth.ok)
    throw new Error(
      `SLACK_TOKEN_REFUSED: auth.test refused the xoxb token of app ${appId}: ${auth.error}`,
    );
  // createBotApp read the token from the app's OAuth page, where the browser
  // still is, so the store captures it there.
  const stored = await s.storeCredential('Bot User OAuth Token', 'token');
  console.log(
    `[${LABEL}] bot ready ${JSON.stringify({ type: token.split('-').shift(), length: token.length, app_id: appId, team: auth.team, team_id: auth.team_id, bot_id: auth.bot_id, stored })}`,
  );
} finally {
  await s.close();
}
