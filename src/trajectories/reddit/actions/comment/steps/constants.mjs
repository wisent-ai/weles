// The waits and bounds of reddit/actions/comment.mjs and its steps.

// Deferred clean-session verify: see organic_comment.mjs for rationale. Wait
// this long after submit confirms in our own session, then re-check the
// comment's public visibility from a fresh proxy + no cookies. Set to 0 to
// disable (legacy behaviour for tests).
export const DEFER_VERIFY_MS = Number(process.env.DEFER_VERIFY_MS ?? 300_000);

// One JSON read of old.reddit.com through the session's own request context.
export const JSON_READ_WAIT_MS = 15000;

// One origin visit while restoring localStorage from the stored storage state.
export const ORIGIN_VISIT_WAIT_MS = 15000;

// The public-visibility poll: twelve long pauses, roughly a minute, which the
// permalink JSON needs to reflect a freshly posted comment.
export const VISIBILITY_POLLS = 12;

// A listing post with this many comments or more is too busy to comment on.
export const BUSY_POST_COMMENTS = 800;

// How many of the newest listing posts a target is picked from.
export const LISTING_PICK_WINDOW = 8;
