import { humanType } from '../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../dist/human/mouse.js';

export async function discordSubmitMessage(s, text) {
  // Discord composer — div[role="textbox"] with class containing "slateTextArea"
  // / data-slate-editor="true". Aria-label is "Message #channel-name".
  const composer = s.page.locator('div[role="textbox"][aria-label^="Message"], div[data-slate-editor="true"][role="textbox"]').filter({ visible: true }).first();
  await composer.waitFor({ state: 'visible', timeout: 15000 });
  await humanClickLocator(s.page, composer);
  await humanType(s.page, text);
  // Press Enter to send (Discord's primary send mechanism — no separate button).
  await s.page.keyboard.press('Enter');
  // Verify state flip — composer cleared.
  await s.page.waitForFunction(() => {
    const c = document.querySelector('div[role="textbox"][aria-label^="Message"], div[data-slate-editor="true"][role="textbox"]');
    return !c || (c.textContent ?? '').trim().length === 0;
  }, { timeout: 15000 }).catch(() => {});
}
