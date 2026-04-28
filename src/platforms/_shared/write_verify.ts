// Verify a promote/comment/reply trajectory actually fired a write API call.
// The agent loop's done(value="...") is a string the LLM emitted — it can
// hallucinate success when the click failed silently. Matching the captured
// responses against per-platform write endpoints catches those false PASSes.

interface CapturedResponse { url: string; status: number; }

const WRITE_PATTERNS: Record<string, RegExp> = {
  twitter: /\/i\/api\/graphql\/[^/]+\/(CreateTweet|CreateNoteTweet|CreateRetweet)/,
  reddit: /\/svc\/shreddit\/(comment|submit)|\/api\/comment|\/api\/submit/,
  instagram: /\/api\/v1\/media\/(\d+\/comment|configure|create)|\/graphql\/.+CreateComment/,
  linkedin: /\/voyager\/api\/(graphql.*createComment|contentcreation\/normShares)/,
  github: /\/issues\/\d+\/comments|\/repos\/[^/]+\/[^/]+\/issues|\/_render_node\//,
  discord: /\/api\/v\d+\/channels\/\d+\/messages/,
  producthunt: /\/frontend\/graphql.*(CreateComment|MakeComment)/,
};

const WRITE_ACTIONS = new Set([
  'promote', 'comment', 'reply', 'organic_reply', 'organic_comment',
  'submit', 'submit_promote', 'post', 'post_promote',
  'open_issue', 'organic_issue_comment', 'organic_message',
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
