import { humanFill } from '../../../../../dist/human/keyboard.js';
import { humanClickLocator, humanIdlePause } from '../../../../../dist/human/mouse.js';
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
  for (let i = 0; i < 8; i++) {
    const text = await bodyText(s.page);
    if (await s.page.locator('ga-admin-web-stream-editor').filter({ visible: true }).first().isVisible().catch(() => false)) break;
    if (/web stream|website url|stream name|choose a platform|data stream|set up a data stream/i.test(text)) {
      await clickAnyLocator(s.page, [
        s.page.locator('button[debug-id="create-web-stream-button"]'),
        s.page.locator('[data-guidedhelpid="data-stream-choose-web"]'),
        s.page.getByRole('button', { name: /^Web$/i }),
        s.page.locator('button').filter({ hasText: /^Web$/i }),
      ]).catch(() => false);
    } else {
      await clickFirst(s.page, [/^Web$/i, /Web stream/i, /Data streams/i, /Create stream/i]).catch(() => false);
    }
    await humanIdlePause('short');
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
  for (let i = 0; i < 30 && !await editor.isVisible().catch(() => false); i++) await humanIdlePause('short');
  if (!await editor.isVisible().catch(() => false)) throw new Error('GA web stream editor did not open');

  const website = editor.locator('input[debug-id="website-url-input"]').first();
  const streamName = editor.locator('input[debug-id="stream-name-input"]').first();
  if (!await website.isVisible().catch(() => false) || !await streamName.isVisible().catch(() => false)) {
    throw new Error('GA web stream fields were not visible');
  }
  await humanFill(s.page, website, siteHostname(values.siteUrl));
  await humanFill(s.page, streamName, values.streamName);
  let clickedCreate = false;
  for (let i = 0; i < 30; i++) {
    if (await clickAnyLocator(s.page, [editor.locator('button[debug-id="create-stream-button"]')]).catch(() => false)) {
      clickedCreate = true;
      break;
    }
    await humanIdlePause('short');
  }
  if (!clickedCreate) throw new Error('GA web stream Create and continue button was not enabled');
  await waitRendered(s.page, 80);
}

async function openGoogleAnalyticsCreatedStreamDetail(s, values) {
  const streamName = new RegExp(escapeRegExp(values.streamName), 'i');
  let opened = false;
  for (let i = 0; i < 30; i++) {
    const text = await bodyText(s.page);
    if (/Measurement ID|View tag instructions|Tag instructions|Stream details/i.test(text)) {
      opened = true;
      break;
    }

    const row = s.page.locator('mat-row, tr, [role="row"]')
      .filter({ hasText: streamName })
      .filter({ visible: true })
      .first();
    if (await row.isVisible().catch(() => false)) {
      const streamIdCell = await row.locator('[debug-id="stream-entity-id"]').first().innerText().then(
        (value) => ({ readable: true, value }),
        (readError) => ({ readable: false, reason: `stream id cell was not readable: ${readError.message}` }),
      );
      const arrow = row.locator('button[aria-label="Select stream"], button').filter({ visible: true }).last();
      if (!await clickAnyLocator(s.page, [arrow]).catch(() => false)) await humanClickLocator(s.page, row);
      for (let j = 0; j < 30; j++) {
        const detailText = await bodyText(s.page);
        if (/Measurement ID|View tag instructions|Tag instructions|Stream details/i.test(detailText)) {
          opened = true;
          break;
        }
        await humanIdlePause('short');
      }
      if (opened || (streamIdCell.readable && streamIdCell.value)) break;
      break;
    }
    await humanIdlePause('short');
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
