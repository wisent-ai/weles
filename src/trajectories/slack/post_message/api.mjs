import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The stored bot token: SLACK_BOT_TOKEN, else ~/.oko/bot-token, else the
 * bot token field of ~/.oko/slack.json. '' when none is stored.
 */
export function storedBotToken() {
  if (process.env.SLACK_BOT_TOKEN?.trim()) return process.env.SLACK_BOT_TOKEN.trim();
  const okoDir = join(homedir(), '.oko');
  const botFile = join(okoDir, 'bot-token');
  try {
    const token = readFileSync(botFile, 'utf8').split('\n')[0].trim();
    if (token.startsWith('xoxb-')) return token;
  } catch {}
  try {
    const cfg = JSON.parse(readFileSync(join(okoDir, 'slack.json'), 'utf8'));
    for (const key of ['bot_token', 'botToken', 'SLACK_BOT_TOKEN']) {
      const token = typeof cfg?.[key] === 'string' ? cfg[key].trim() : '';
      if (token.startsWith('xoxb-')) return token;
    }
  } catch {}
  return '';
}

export function encodeForm(form) {
  return Object.entries(form).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');
}

/** One Slack Web API call with a bearer token; throws with Slack's own error name. */
export async function slackPost(method, form, token) {
  const body = encodeForm(form);
  const r = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const j = await r.json();
  if (!j.ok) throw new Error(`${method}: ${j.error}${j.needed ? ` (needed ${j.needed})` : ''}`);
  return j;
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
    if (!j.ok) throw new Error(`${method}: ${j.error || JSON.stringify(j).slice(0, 80)}`);
    return j;
  };
}
