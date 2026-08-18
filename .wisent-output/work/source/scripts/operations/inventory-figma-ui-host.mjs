#!/usr/bin/env node
import { WSession } from '../../dist/session/wsession.js';

process.env.WELES_NO_INSTRUMENT = '1';
process.env.WELES_DISABLE_RECORDING = '1';
process.env.WELES_PAGE_DIAGNOSTICS = '0';

const teamId = '1496228249916610388';
const session = await WSession.start({
  label: 'figma_company_file_inventory',
  targetHost: 'www.figma.com',
  headless: true,
  browser: 'chromium',
  userDataDir: process.env.WELES_USER_DATA_DIR,
});
try {
  await session.goto(`https://www.figma.com/files/team/${teamId}/recents-and-sharing`);
  await session.page.waitForTimeout(1500);
  const cards = new Map();
  const links = new Map();
  for (let pass = 0; pass < 30; pass += 1) {
    const batch = await session.page.evaluate(() => {
      const tidy = (value) => String(value || '').replace(/\s+/g, ' ').trim();
      const headingRows = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'))
        .map((heading) => {
          const text = tidy(heading.getAttribute('aria-label') || heading.textContent);
          let clickable = heading.closest('a,button,[role="button"],[role="link"],[tabindex]');
          let current = heading.parentElement;
          while (!clickable && current && current !== document.body) {
            if (current.matches('a,button,[role="button"],[role="link"],[tabindex]')) clickable = current;
            current = current.parentElement;
          }
          const attributes = {};
          if (clickable) {
            for (const attribute of clickable.attributes) {
              if (/^(?:href|aria-|data-|role|tabindex)/.test(attribute.name)) {
                attributes[attribute.name] = attribute.value;
              }
            }
          }
          return { text, tag: heading.tagName.toLowerCase(), attributes };
        })
        .filter((entry) => entry.text);
      const linkRows = Array.from(document.querySelectorAll('a[href]'))
        .map((element) => ({
          text: tidy(element.getAttribute('aria-label') || element.textContent),
          href: element.href,
        }))
        .filter((entry) => /figma\.com\//i.test(entry.href));
      const scrollables = Array.from(document.querySelectorAll('*'))
        .filter((element) => element.scrollHeight > element.clientHeight + 50)
        .sort((left, right) => right.scrollHeight - left.scrollHeight);
      const scroller = scrollables[0] || document.scrollingElement;
      const before = scroller?.scrollTop || 0;
      if (scroller) scroller.scrollTop = Math.min(
        scroller.scrollHeight,
        before + Math.max(scroller.clientHeight * 0.8, 400),
      );
      return {
        headingRows,
        linkRows,
        before,
        after: scroller?.scrollTop || 0,
      };
    });
    for (const card of batch.headingRows) cards.set(card.text, card);
    for (const link of batch.linkRows) links.set(link.href, link);
    if (pass > 0 && batch.after <= batch.before) break;
    await session.page.waitForTimeout(250);
  }
  const companyFiles = [];
  const companyNames = Array.from(cards.keys())
    .filter((name) => name !== 'Recents');
  for (const name of companyNames) {
    await session.goto(`https://www.figma.com/files/team/${teamId}/recents-and-sharing`);
    await session.page.waitForTimeout(800);
    const card = session.page.getByRole('group', { name, exact: true }).first();
    if (!await card.isVisible().catch(() => false)) {
      companyFiles.push({ name, url: null, error: 'card not visible' });
      continue;
    }
    const popupPromise = session.page.context().waitForEvent('page', { timeout: 5000 }).catch(() => null);
    await card.dblclick({ noWaitAfter: true });
    await session.page.waitForTimeout(2000);
    const opened = await popupPromise;
    const candidates = [opened, ...session.page.context().pages()]
      .filter(Boolean)
      .filter((page, index, all) => all.indexOf(page) === index);
    const filePage = candidates.find((page) => /figma\.com\/(?:design|file|board|slides|make|proto)\//i.test(page.url()));
    companyFiles.push({
      name,
      url: filePage?.url() || null,
      error: filePage ? null : 'file URL not exposed after double click',
    });
    if (opened && opened !== session.page) await opened.close().catch(() => {});
  }
  console.log(JSON.stringify({
    url: session.page.url(),
    cards: Array.from(cards.values()),
    links: Array.from(links.values()),
    companyFiles,
  }));
} finally {
  await session.ctx.close().catch(() => {});
}
