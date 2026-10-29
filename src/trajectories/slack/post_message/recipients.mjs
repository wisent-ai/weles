// Who a Slack message goes to and whom it mentions, read through a Slack
// directory: `directory(method, key, form)` resolves every entry of one
// listing (`slackDirectory` as the bot, `workspaceDirectory` as the signed-in
// client), so both routes resolve recipients the same way.

// Default recipients: one user per matcher group, read from
// SLACK_RECIPIENT_GROUPS ('name,alias;name,alias'). The people a message goes
// to are deployment configuration, not code.
// chat.postMessage to a user id opens/uses the DM, so no im:write needed.
export const RECIPIENT_GROUPS = parseMatcherGroups(
  process.env.SLACK_RECIPIENT_GROUPS,
  [],
);

const TARGET_NAME = process.env.SLACK_TARGET_CHANNEL_NAME?.toLowerCase();
const TARGET_CHAN = process.env.SLACK_TARGET_CHANNEL;
const TAGGING_ENABLED = process.env.SLACK_ENABLE_TAGGING !== '0';

/** How mentions join a channel post, as SLACK_MENTION_MODE states it. */
function mentionMode() {
  return process.env.SLACK_MENTION_MODE?.trim().toLowerCase();
}

export function parseCsv(value) {
  return value
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Matcher groups from 'a,b;c,d' text; the given groups when the text is empty. */
export function parseMatcherGroups(value, defaults) {
  if (!value) return defaults;
  return String(value)
    .toLowerCase()
    .split(/[;|]/)
    .map((group) =>
      group
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .filter((group) => group.length);
}

function memberFields(user) {
  return [
    user.name,
    user.real_name,
    user.profile?.email,
    user.profile?.display_name,
  ]
    .filter(Boolean)
    .map((x) => String(x).toLowerCase());
}

/** The first member matching each group, without duplicates; a group nobody matches is logged. */
export function resolveUsersFromMembers(members, groups) {
  const hits = [];
  for (const group of groups) {
    const hit = members.find((user) => {
      const fields = memberFields(user);
      return group.some((matcher) =>
        fields.some((field) => field.includes(matcher)),
      );
    });
    if (hit && !hits.some((u) => u.id === hit.id)) hits.push(hit);
    else if (!hit)
      console.log(`[slack] WARN no user matched ${group.join('/')}`);
  }
  return hits;
}

export function isChannelTarget(target) {
  return typeof target === 'string' && /^[CG][A-Z\d]+$/.test(target);
}

function alreadyMentioned(text, id) {
  return new RegExp(`<@${id}(?:\\|[^>]+)?>`).test(text);
}

/**
 * The message with the missing mentions added where SLACK_MENTION_MODE puts
 * them: prefix, append or none. With someone to mention and the mode unset
 * or another word, the post is refused by name: guessing it placed mentions
 * the caller never chose.
 */
export function applyMentions(text, ids) {
  if (!TAGGING_ENABLED || !ids.length) return text;
  const missing = ids.filter((id) => !alreadyMentioned(text, id));
  if (!missing.length) return text;
  const tags = missing.map((id) => `<@${id}>`).join(' ');
  const mode = mentionMode();
  switch (mode) {
    case 'prefix':
      return `${tags}\n\n${text}`;
    case 'append':
      return `${text.trimEnd()}\n\n${tags}\n`;
    case 'none':
      return text;
  }
  throw new Error(
    `SLACK_MENTION_MODE is ${mode ? `"${mode}"` : 'not set'}: name prefix, append or none for how the mentions of ${missing.join(', ')} join the post; nothing was posted`,
  );
}

/** Who to mention in a channel post: explicit ids, else the matcher groups resolved against the members. */
export async function mentionIdsForTarget(target, loadMembers) {
  if (!TAGGING_ENABLED || mentionMode() === 'none' || !isChannelTarget(target))
    return [];
  const stated = process.env.SLACK_MENTION_USER_IDS;
  if (stated) return [...new Set(parseCsv(stated))];

  const groups = parseMatcherGroups(
    process.env.SLACK_MENTION_USER_MATCHERS,
    RECIPIENT_GROUPS,
  );
  const members = await loadMembers();
  const hits = resolveUsersFromMembers(members, groups);
  for (const hit of hits)
    console.log(`[slack] mention ${hit.real_name || hit.name} -> ${hit.id}`);
  return hits.map((hit) => hit.id);
}

/** Every workspace member that is neither deleted nor a bot. */
export async function listMembers(directory) {
  const members = await directory('users.list', 'members', {
    limit: '1000',
  });
  return members.filter((u) => !u.deleted && !u.is_bot);
}

/**
 * Where the message goes: an explicit channel id, explicit DM user ids, a
 * channel by name, else one DM per recipient group. A channel named but not
 * found (or a channel list that could not be read) refuses: a message meant
 * for a channel is never sent to people instead.
 */
export async function resolveTargets(directory) {
  if (TARGET_CHAN) return [TARGET_CHAN];
  if (process.env.SLACK_TARGET_USER_IDS)
    return parseCsv(process.env.SLACK_TARGET_USER_IDS);
  if (process.env.SLACK_TARGET_USER_ID)
    return [process.env.SLACK_TARGET_USER_ID];
  if (process.env.SLACK_TARGET_CHANNEL_NAME) {
    const channels = await directory('conversations.list', 'channels', {
      types: 'public_channel,private_channel',
      limit: '1000',
    });
    const c = channels.find(
      (x) => x.name && x.name.toLowerCase() === TARGET_NAME,
    );
    if (!c)
      throw new Error(
        `no visible channel named "${TARGET_NAME}" among ${channels.length}; nothing was posted`,
      );
    return [c.id];
  }
  // DM one user per recipient group, resolved by name/email matcher.
  const groups = process.env.SLACK_TARGET_USER_MATCHERS
    ? [parseCsv(process.env.SLACK_TARGET_USER_MATCHERS.toLowerCase())]
    : RECIPIENT_GROUPS;
  const members = await listMembers(directory);
  const ids = [];
  for (const group of groups) {
    const [hit] = resolveUsersFromMembers(members, [group]);
    if (hit && !ids.includes(hit.id)) {
      ids.push(hit.id);
      console.log(
        `[slack] recipient ${hit.real_name || hit.name} -> ${hit.id}`,
      );
    }
  }
  if (!ids.length)
    throw new Error(
      'no channel was named and nobody matched the recipient groups: set SLACK_TARGET_CHANNEL, SLACK_TARGET_CHANNEL_NAME, SLACK_TARGET_USER_IDS or SLACK_RECIPIENT_GROUPS',
    );
  return ids;
}
