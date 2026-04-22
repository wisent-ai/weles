import { runAction } from '../../_shared/action-runner.mjs';
import { detectLinkedInBanSignals } from '../../../../dist/platforms/linkedin/ban_signals.js';

const ACTION = process.env.POST_PROMOTE === '1' ? 'post_promote' : 'post';

await runAction({
  platform: 'linkedin',
  action: ACTION,
  feedUrl: 'https://www.linkedin.com/feed/?startPost=true',
  banDetector: detectLinkedInBanSignals,
  surfaceLabel: 'linkedin',
  postGoal: (text) => `You are on LinkedIn's feed with the Start-a-Post modal open. Do the following:\n1. Click into the post-content editor area (a rich-text box with placeholder "What do you want to talk about?").\n2. Type exactly: ${text}\n3. Find the Post button at the bottom-right of the modal (labelled "Post", primary button, not the dropdown arrow next to it) and click it.\nAfter the modal closes, done(value="posted"). Do NOT navigate() manually. Do NOT add hashtags or images.`,
});
