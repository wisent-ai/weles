import { integrationAction, integrationsConfigured } from '../../../_shared/integrations.mjs';

/**
 * The Slack identity Weles posts as when it does not drive the browser: the
 * Swiatowid bot, whose token is wisent-integrations' provider item
 * `slack-swiatowid-bot`. Weles itself holds no Slack token.
 */
export const BOT_IDENTITY = 'swiatowid-bot';

/** Whether the bot can be reached through wisent-integrations at all. */
export const botConfigured = integrationsConfigured;

export function encodeForm(form) {
  return Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

/**
 * One Slack call as the bot, through wisent-integrations' `slack` domain.
 * `auth.test`, `users.list` and `conversations.list` answer Slack's own
 * fields; `chat.postMessage` answers `ts`, `channel` and `user`. A refusal
 * carries Slack's own error word.
 */
export async function slackPost(method, form) {
  const identity = { identity: BOT_IDENTITY };
  if (method === 'auth.test') return integrationAction('slack', 'auth.test', identity);
  if (method === 'users.list' || method === 'conversations.list') {
    return integrationAction('slack', method, { ...identity, limit: Number(form.limit || 1000), ...(form.types ? { types: form.types } : {}) });
  }
  if (method === 'chat.postMessage') {
    return integrationAction('slack', 'chat.post_message', { ...identity, channel: form.channel, text: form.text });
  }
  throw new Error(`${method}: not a Slack method Weles reaches through wisent-integrations`);
}

/** The same call through the signed-in browser context, for the client (xoxc) token. */
export function workspaceApi(request) {
  return async function slackApi(method, form) {
    const body = encodeForm(form);
    const r = await request.post(`https://wisent-workspace.slack.com/api/${method}?_x_id=${Date.now()}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      data: body,
    });
    const j = await r.json();
    if (!j.ok) throw new Error(`${method}: ${j.error || JSON.stringify(j)}`);
    return j;
  };
}
