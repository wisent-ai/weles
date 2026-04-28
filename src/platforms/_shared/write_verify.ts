// Verify a promote/comment/reply trajectory actually fired a write API call.
// The agent loop's done(value="...") is a string the LLM emitted — it can
// hallucinate success when the click failed silently. Matching the captured
// responses against per-platform write endpoints catches those false PASSes.

interface CapturedResponse { url: string; status: number; }

const WRITE_PATTERNS: Record<string, RegExp> = {
  twitter: /\/i\/api\/graphql\/[^/]+\/(CreateTweet|CreateNoteTweet|CreateRetweet|FavoriteTweet|UnfavoriteTweet|CreateRetweet|FollowUser|CreateBookmark)/,
  reddit: /\/svc\/shreddit\/(comment|submit|vote|subscribe)|\/api\/(comment|submit|vote|subscribe)/,
  instagram: /\/api\/v1\/media\/(\d+\/(comment|like|save)|configure|create)|\/graphql\/.+(CreateComment|LikeMedia|FollowUser)|\/api\/v1\/friendships\/(create|destroy)/,
  linkedin: /\/voyager\/api\/(graphql.*(createComment|reactToEntity|inviteV2)|contentcreation\/normShares|relationships\/invitations|growth\/normalizedExpressionsCreation)/,
  github: /\/issues\/\d+\/comments|\/repos\/[^/]+\/[^/]+\/issues|\/_render_node\/|\/(starred|subscriptions|following|user\/following)\//,
  discord: /\/api\/v\d+\/channels\/\d+\/messages|\/api\/v\d+\/users\/@me\/relationships|\/api\/v\d+\/invites/,
  tiktok: /\/api\/(comment\/publish|commit\/follow_user|commit\/item\/digg|aweme\/v1\/comment\/publish|aweme\/v1\/commit\/user\/follow|video\/like\/save)/,
  producthunt: /\/frontend\/graphql.*(CreateComment|MakeComment|CreateVote|FollowUser)/,
};

const WRITE_ACTIONS = new Set([
  'promote', 'comment', 'reply', 'organic_reply', 'organic_comment',
  'submit', 'submit_promote', 'post', 'post_promote',
  'open_issue', 'organic_issue_comment', 'organic_message',
  // Single-action verbs that DO mutate platform state but were missing
  // — agent done() on these previously couldn't be verified.
  'connect', 'endorse', 'react', 'follow', 'like', 'upvote', 'bookmark',
  'star', 'fork', 'create_repo', 'commit', 'watch_repo', 'join_server',
  'join_sub', 'react', 'add_friend',
]);

export function isWriteAction(action: string): boolean {
  return WRITE_ACTIONS.has(action);
}

export interface VerifyResult {
  applicable: boolean;
  wrote?: boolean;
  matched_url?: string;
}

export function verifyWriteAction(
  platform: string,
  action: string,
  capturedResponses: CapturedResponse[],
): VerifyResult {
  if (!isWriteAction(action)) return { applicable: false };
  const pat = WRITE_PATTERNS[platform];
  if (!pat) return { applicable: false };
  const hit = capturedResponses.find(r => pat.test(r.url) && r.status >= 200 && r.status < 300);
  return { applicable: true, wrote: !!hit, matched_url: hit?.url };
}
