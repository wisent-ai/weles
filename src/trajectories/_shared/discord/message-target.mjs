import { humanScroll } from '../../../../dist/human/mouse.js';
import { pageSettled } from '../page/settled.mjs';

export async function findDiscordMessage(page, channelPath, channelId, text, errorPrefix) {
  const target = page.locator('li[id^="chat-messages-"]').filter({ hasText: text }).first();
  const oldestMessageId = () => page.locator('li[id^="chat-messages-"]').first().getAttribute('id');
  while ((await target.count()) === 0) {
    const before = await oldestMessageId();
    await humanScroll(page, -800, 2);
    await pageSettled(page);
    if ((await target.count()) > 0) break;
    const after = await oldestMessageId();
    // An unchanged rendered window is not evidence that older history ended.
    if (after === before) throw Object.assign(new Error(`${errorPrefix}_HISTORY_PROGRESS_UNCONFIRMED: the rendered history did not advance; earlier-message availability is unknown`),
      { channel: channelPath, oldestMessageBefore: before, oldestMessageAfter: after, pageUrl: page.url() });
  }
  const targetElementId = await target.getAttribute('id');
  const targetId = /^chat-messages-(\d+)-(\d+)$/.exec(targetElementId || '');
  if (!targetId || targetId[1] !== channelId) throw Object.assign(new Error(`${errorPrefix}_PARENT_UNCONFIRMED`),
    { channel: channelPath, targetElementId, pageUrl: page.url() });
  return { target, messageId: targetId[2] };
}
