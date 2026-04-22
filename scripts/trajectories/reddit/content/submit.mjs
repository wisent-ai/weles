import { runAction } from '../../_shared/action-runner.mjs';
import { detectRedditBanSignals } from '../../../../dist/platforms/reddit/ban_signals.js';

const ACTION = process.env.POST_PROMOTE === '1' ? 'post_promote' : 'post';
const SUBREDDIT = (process.env.SUBREDDIT || '').replace(/^r\//, '');
if (!SUBREDDIT) { console.log('FAIL: SUBREDDIT required for reddit submit'); process.exit(1); }

// Reddit submit UI wants a title + body. The LLM currently generates a single
// body blob — we split on the first sentence to feed title/body. Agent loop
// handles both fields in the Compose UI.
await runAction({
  platform: 'reddit',
  action: ACTION,
  feedUrl: `https://www.reddit.com/r/${encodeURIComponent(SUBREDDIT)}/submit`,
  banDetector: detectRedditBanSignals,
  surfaceLabel: `r/${SUBREDDIT}`,
  postGoal: (text) => {
    const idx = text.indexOf('.');
    const title = (idx > 5 && idx < 120 ? text.slice(0, idx) : text.slice(0, 100)).trim();
    const body  = (idx > 5 ? text.slice(idx + 1) : '').trim();
    return `You are on reddit's Submit-post form for r/${SUBREDDIT}. Do the following:\n1. Click the "Text" post-type tab if not already selected.\n2. Click the Title field and type exactly: ${title}\n3. Click the Body field and type exactly: ${body || '(no body)'}\n4. Click the Post button at the bottom-right of the form.\nAfter URL advances to a permalinked post URL (/r/${SUBREDDIT}/comments/...), done(value="submitted"). Do NOT navigate() manually.`;
  },
});
