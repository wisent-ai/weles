import { slackPost } from './api.mjs';

// Default recipients: one user per matcher-group. We DM BOTH Jakub and Łukasz.
// chat.postMessage to a user id opens/uses the DM, so no im:write needed.
export const RECIPIENT_GROUPS = [
  ['jakub', 'towarek', 'kuba'],
  ['lukasz', 'bartoszcze', 'łukasz'],
];

const TARGET_NAME = (process.env.SLACK_TARGET_CHANNEL_NAME || 'jakub').toLowerCase();
const TARGET_CHAN = process.env.SLACK_TARGET_CHANNEL || '';
const TAGGING_ENABLED = process.env.SLACK_ENABLE_TAGGING !== '0';
const MENTION_MODE = (process.env.SLACK_MENTION_MODE || 'prefix').toLowerCase();

export function parseCsv(value) {
  return String(value || '').split(',').map((x) => x.trim()).filter(Boolean);
}

/** Matcher groups from 'a,b;c,d' text; the given groups when the text is empty. */
export function parseMatcherGroups(value, defaults = RECIPIENT_GROUPS) {
  if (!value) return defaults;
  return String(value)
    .toLowerCase()
    .split(/[;|]/)
    .map((group) => group.split(',').map((x) => x.trim()).filter(Boolean))
    .filter((group) => group.length);
}

function memberFields(user) {
  const profile = user.profile || {};
  return [user.name, user.real_name, profile.email, profile.display_name]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());
}

/** The first member matching each group, without duplicates; a group nobody matches is logged. */
export function resolveUsersFromMembers(members, groups) {
  const hits = [];
  for (const group of groups) {
    const hit = members.find((user) => {
      const fields = memberFields(user);
      return group.some((matcher) => fields.some((field) => field.includes(matcher)));
    });
    if (hit && !hits.some((u) => u.id === hit.id)) hits.push(hit);
    else if (!hit) console.log(`[slack] WARN no user matched ${group.join('/')}`);
  }
  return hits;
}

export function isChannelTarget(target) {
  return /^[CG][A-Z0-9]+$/.test(String(target || ''));
}

function alreadyMentioned(text, id) {
  return new RegExp(`<@${id}(?:\\|[^>]+)?>`).test(text);
}

/** The message with the missing mentions added as a prefix or an appendix. */
export function applyMentions(text, ids) {
  if (!TAGGING_ENABLED || MENTION_MODE === 'none' || !ids.length) return text;
  const missing = ids.filter((id) => !alreadyMentioned(text, id));
  if (!missing.length) return text;
  const prefix = missing.map((id) => `<@${id}>`).join(' ');
  if (MENTION_MODE === 'append') return `${text.trimEnd()}\n\n${prefix}\n`;
  return `${prefix}\n\n${text}`;
}

/** Who to mention in a channel post: explicit ids, else the matcher groups resolved against the members. */
export async function mentionIdsForTarget(target, loadMembers) {
  if (!TAGGING_ENABLED || MENTION_MODE === 'none' || !isChannelTarget(target)) return [];
  const explicit = parseCsv(process.env.SLACK_MENTION_USER_IDS || process.env.SLACK_MENTION_USER_ID);
  if (explicit.length) return [...new Set(explicit)];

  const groups = parseMatcherGroups(process.env.SLACK_MENTION_USER_MATCHERS, RECIPIENT_GROUPS);
  const members = await loadMembers();
  const hits = resolveUsersFromMembers(members, groups);
  for (const hit of hits) console.log(`[slack] mention ${hit.real_name || hit.name} -> ${hit.id}`);
  return hits.map((hit) => hit.id);
}

/** Every workspace member that is neither deleted nor a bot. */
export async function listMembers(token) {
  const ul = await slackPost('users.list', { limit: '1000' }, token);
  return (ul.members || []).filter((u) => !u.deleted && !u.is_bot);
}

/**
 * Where the message goes: an explicit channel id, explicit DM user ids, a
 * channel by name when one resolves, else one DM per recipient group.
 */
export async function resolveTargets(token) {
  if (TARGET_CHAN) return [TARGET_CHAN];
  if (process.env.SLACK_TARGET_USER_IDS) return parseCsv(process.env.SLACK_TARGET_USER_IDS);
  if (process.env.SLACK_TARGET_USER_ID) return [process.env.SLACK_TARGET_USER_ID];
  // A real channel by name only if it actually resolves: the default 'jakub'
  // is a DM, not a channel, so it is answered by the recipient groups below.
  if (process.env.SLACK_TARGET_CHANNEL_NAME) {
    try {
      const list = await slackPost('conversations.list', { types: 'public_channel,private_channel', limit: '1000' }, token);
      const c = (list.channels || []).find((x) => (x.name || '').toLowerCase() === TARGET_NAME);
      if (c) return [c.id];
      console.log(`[slack] no visible channel named "${TARGET_NAME}" — resolving user targets instead`);
    } catch (e) { console.log(`[slack] conversations.list skipped: ${e.message}`); }
  }
  // DM one user per recipient group, resolved by name/email matcher.
  const groups = process.env.SLACK_TARGET_USER_MATCHERS
    ? [parseCsv(process.env.SLACK_TARGET_USER_MATCHERS.toLowerCase())]
    : RECIPIENT_GROUPS;
  const members = await listMembers(token);
  const ids = [];
  for (const group of groups) {
    const hit = resolveUsersFromMembers(members, [group])[0];
    if (hit && !ids.includes(hit.id)) { ids.push(hit.id); console.log(`[slack] recipient ${hit.real_name || hit.name} -> ${hit.id}`); }
  }
  if (!ids.length) throw new Error(`no channel "${TARGET_NAME}" and no recipients matched`);
  return ids;
}
