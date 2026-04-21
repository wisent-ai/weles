import { runAction } from '../_shared/action-runner.mjs';
import { detectDiscordBanSignals } from '../../../dist/platforms/discord/ban_signals.js';

const channelPath = process.env.SERVER_CHANNEL_PATH || '@me';
await runAction({
  platform: 'discord', action: 'promote',
  feedUrl: `https://discord.com/channels/${channelPath}`,
  surfaceLabel: 'discord channel',
  pickPost: async (s) => {
    try {
      const text = await s.page.evaluate(() => {
        const messages = Array.from(document.querySelectorAll('[class*="messageContent"]')).slice(-5);
        const last = messages[messages.length - 1];
        return last?.textContent?.trim() ?? '';
      });
      return { postTitle: (text || '').slice(0, 300), postBody: '' };
    } catch { return { postTitle: '', postBody: '' }; }
  },
  commentGoal: (text) => `Find the message composer at the bottom (placeholder "Message #..."). fill(target="Message", value=${JSON.stringify(text)}). Press Enter to send. done(value="promoted"). Do NOT navigate(). Do NOT give_up.`,
  banDetector: detectDiscordBanSignals,
});
