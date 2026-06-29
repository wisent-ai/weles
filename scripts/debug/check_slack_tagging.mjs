#!/usr/bin/env node
// Read-only Slack tagging/recipient diagnostic.
// Checks bot token validity and whether default channel mentions resolve.
// Does not call chat.postMessage.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function storedBotToken() {
  if (process.env.SLACK_BOT_TOKEN) return { token: process.env.SLACK_BOT_TOKEN.trim(), source: 'env:SLACK_BOT_TOKEN' };
  const f = join(homedir(), '.oko', 'bot-token');
  try {
    if (!existsSync(f)) return { token: '', source: null };
    const token = readFileSync(f, 'utf8').split('\n')[0].trim();
    return token.startsWith('xoxb-') ? { token, source: f } : { token: '', source: null };
  } catch {
    return { token: '', source: null };
  }
}

async function slackGet(method, token, params = {}) {
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return await res.json();
}

function memberFields(user) {
  const profile = user.profile || {};
  return [user.name, user.real_name, profile.email, profile.display_name]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());
}

function resolveGroups(members, groups) {
  return groups.map((group) => {
    const hit = members.find((user) => group.some((matcher) => memberFields(user).some((field) => field.includes(matcher))));
    return {
      matchers: group,
      hit: hit ? {
        id: hit.id,
        mention: `<@${hit.id}>`,
        name: hit.name || null,
        real_name: hit.real_name || null,
        email: hit.profile?.email || null,
        is_restricted: hit.is_restricted || false,
        is_ultra_restricted: hit.is_ultra_restricted || false,
      } : null,
    };
  });
}

function parseMatcherGroups(value, fallback) {
  if (!value) return fallback;
  return String(value)
    .toLowerCase()
    .split(/[;|]/)
    .map((group) => group.split(',').map((x) => x.trim()).filter(Boolean))
    .filter((group) => group.length);
}

const { token, source } = storedBotToken();
if (!token) {
  console.log(JSON.stringify({ ok: false, error: 'missing_slack_bot_token' }, null, 2));
  process.exit(0);
}

const auth = await slackGet('auth.test', token);
const users = await slackGet('users.list', token, { limit: '1000' });
const channels = await slackGet('conversations.list', token, { types: 'public_channel,private_channel', limit: '1000' });
const members = users.ok ? (users.members || []).filter((u) => !u.deleted && !u.is_bot) : [];
const defaultGroups = [
  ['jakub', 'kuba', 'towarek'],
  ['lukasz', 'bartoszcze', 'łukasz'],
];
const groups = parseMatcherGroups(process.env.SLACK_MENTION_USER_MATCHERS, defaultGroups);

const resolved = resolveGroups(members, groups);
const mentionIds = resolved.map((x) => x.hit?.id).filter(Boolean);
const mentionPrefix = mentionIds.map((id) => `<@${id}>`).join(' ');

console.log(JSON.stringify({
  ok: Boolean(auth.ok && users.ok),
  token_source: source,
  bot_auth: auth.ok ? {
    team: auth.team,
    team_id: auth.team_id,
    bot_user: auth.user,
    bot_user_id: auth.user_id,
  } : { ok: false, error: auth.error || null },
  users_list_ok: Boolean(users.ok),
  users_error: users.ok ? null : users.error || null,
  conversations_list_ok: Boolean(channels.ok),
  conversations_error: channels.ok ? null : channels.error || null,
  visible_channels: channels.ok ? (channels.channels || []).map((c) => ({
    id: c.id,
    name: c.name,
    is_private: Boolean(c.is_private),
    is_member: Boolean(c.is_member),
  })) : [],
  non_bot_members: members.length,
  default_mentions: resolved,
  channel_message_prefix: mentionPrefix || null,
  current_behavior: {
    dm_delivery: 'unchanged_for_user_targets',
    channel_tagging: mentionIds.length ? 'implemented_for_channel_targets' : 'blocked_until_mention_users_resolve',
    required_channel_mention_format: '<@USERID>',
    dry_run_command: 'SLACK_DRY_RUN=1 SLACK_TARGET_CHANNEL_NAME=general node scripts/trajectories/slack/post_message.mjs',
  },
}, null, 2));
