import { humanFill } from '../../../../../dist/human/keyboard.js';
import { humanClickLocator } from '../../../../../dist/human/mouse.js';
import { pageSettled } from '../../page/settled.mjs';
import { input, siteHostname } from '../action-catalog.mjs';
import {
  escapeRegExp,
  bodyText,
  waitRendered,
  clickFirst,
  clickCardLike,
  clickAnyLocator,
} from '../page-interaction.mjs';

function extractGaMeasurementId(text) {
  return text.match(/\bG-[A-Z0-9]+\b/)?.[0] ?? null;
}

async function openDataStreamDetail(s) {
  if (!/\/admin\/streams\/table/.test(s.page.url())) return false;
  const streamId = input('STREAM_ID');
  const streamName = input('STREAM_NAME');
  const candidates = [];
  if (streamId && streamId !== 'unknown-stream') candidates.push(new RegExp(streamId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  if (streamName) candidates.push(new RegExp(`^${streamName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'));
  candidates.push(/\b\d{6,}\b/);
  for (const candidate of candidates) {
    if (await clickFirst(s.page, [candidate])) return true;
    if (await clickCardLike(s.page, candidate)) return true;
  }
  return false;
}

async function fillGoogleAnalyticsWebStreamStep(s, values) {
  // One walk toward the editor: from a data-streams screen the Web platform
  // button opens it; from anywhere else the Data streams entry comes first.
  // Each click leaves the page settled before the next look.
  await pageSettled(s.page);
  if (!await s.page.locator('ga-admin-web-stream-editor').filter({ visible: true }).first().isVisible().catch(() => false)) {
    const text = await bodyText(s.page);
    if (!/web stream|website url|stream name|choose a platform|data stream|set up a data stream/i.test(text)) {
      await clickFirst(s.page, [/^Web$/i, /Web stream/i, /Data streams/i, /Create stream/i]).catch(() => false);
    }
  }

  const editor = s.page.locator('ga-admin-web-stream-editor').filter({ visible: true }).first();
  if (!await editor.isVisible().catch(() => false)) {
    await clickAnyLocator(s.page, [
      s.page.locator('button[debug-id="create-web-stream-button"]'),
      s.page.locator('[data-guidedhelpid="data-stream-choose-web"]'),
      s.page.getByRole('button', { name: /^Web$/i }),
      s.page.locator('button').filter({ hasText: /^Web$/i }),
    ], 'GA Web stream platform button');
  }
  await pageSettled(s.page);
  if (!await editor.isVisible().catch(() => false)) throw new Error('GA web stream editor did not open');

  const website = editor.locator('input[debug-id="website-url-input"]').first();
  const streamName = editor.locator('input[debug-id="stream-name-input"]').first();
  if (!await website.isVisible().catch(() => false) || !await streamName.isVisible().catch(() => false)) {
    throw new Error('GA web stream fields were not visible');
  }
  await humanFill(s.page, website, siteHostname(values.siteUrl));
  await humanFill(s.page, streamName, values.streamName);
  if (!await clickAnyLocator(s.page, [editor.locator('button[debug-id="create-stream-button"]')]).catch(() => false)) {
    throw new Error('GA web stream Create and continue button was not enabled');
  }
  await waitRendered(s.page, 80);
}

async function openGoogleAnalyticsCreatedStreamDetail(s, values) {
  const streamName = new RegExp(escapeRegExp(values.streamName), 'i');
  const detailShown = async () => /Measurement ID|View tag instructions|Tag instructions|Stream details/i.test(await bodyText(s.page));
  await pageSettled(s.page);
  let opened = await detailShown();
  if (!opened) {
    const row = s.page.locator('mat-row, tr, [role="row"]')
      .filter({ hasText: streamName })
      .filter({ visible: true })
      .first();
    if (await row.isVisible().catch(() => false)) {
      const arrow = row.locator('button[aria-label="Select stream"], button').filter({ visible: true }).last();
      if (!await clickAnyLocator(s.page, [arrow]).catch(() => false)) await humanClickLocator(s.page, row);
      await pageSettled(s.page);
      opened = await detailShown();
    }
  }

  if (opened) {
    await clickAnyLocator(s.page, [
      s.page.getByRole('button', { name: /View tag instructions|Tag instructions|Google tag|Installation instructions/i }),
      s.page.locator('button, [role="button"], a').filter({ hasText: /View tag instructions|Tag instructions|Google tag|Installation instructions/i }),
    ]).catch(() => false);
    await waitRendered(s.page, 80);
  }
}

export {
  extractGaMeasurementId,
  openDataStreamDetail,
  fillGoogleAnalyticsWebStreamStep,
  openGoogleAnalyticsCreatedStreamDetail,
};
