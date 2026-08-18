#!/usr/bin/env node
import { WSession } from '../../dist/session/wsession.js';

process.env.WELES_NO_INSTRUMENT = '1';
process.env.WELES_DISABLE_RECORDING = '1';
process.env.WELES_PAGE_DIAGNOSTICS = '0';

const session = await WSession.start({
  label: 'figma_card_inspection',
  targetHost: 'www.figma.com',
  headless: true,
  browser: 'chromium',
  userDataDir: process.env.WELES_USER_DATA_DIR,
});
try {
  await session.goto('https://www.figma.com/files/team/1496228249916610388/recents-and-sharing');
  await session.page.waitForTimeout(1500);
  const result = await session.page.evaluate(() => {
    const tidy = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const targets = new Set(['Wisent Web App']);
    return Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
      .filter((heading) => targets.has(tidy(heading.getAttribute('aria-label') || heading.textContent)))
      .map((heading) => {
        const ancestry = [];
        let element = heading;
        for (let depth = 0; element && depth < 14; depth += 1, element = element.parentElement) {
          const attributes = {};
          for (const attribute of element.attributes) {
            if (/^(?:href|aria-|data-|role|tabindex|id|draggable)/.test(attribute.name)) attributes[attribute.name] = attribute.value;
          }
          ancestry.push({ tag: element.tagName.toLowerCase(), attributes });
        }
        return { name: tidy(heading.textContent), ancestry };
      });
  });
  console.log(JSON.stringify(result));
} finally {
  await session.ctx.close().catch(() => {});
}
