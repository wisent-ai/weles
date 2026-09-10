// Whether the public no-login scanner sits behind a Cloudflare Turnstile gate
// and whether this run can pass it: read the page state, locate the widget by
// marker or by geometry, click the checkbox inside the frame or - for a
// cross-origin frame - its computed point, and wait for the scan button to
// unlock. Separate from the form because this describes somebody else's
// anti-bot gate and changes when Cloudflare changes the widget.

import { humanClickLocator, humanMove } from '../../../../../dist/human/mouse.js';

async function publicVerificationState(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    // Attributes a node does not carry are simply left out of the marker.
    const buttonLabel = (el) => {
      const sources = [el.textContent, el.getAttribute('aria-label'), el.getAttribute('value')];
      const raw = sources.find((value) => value);
      if (!raw) return '';
      return raw.replace(/\s+/g, ' ').trim();
    };
    const body = document.body?.innerText || '';
    const visibleFrames = Array.from(document.querySelectorAll('iframe')).filter(visible).map((el) => {
      const rect = el.getBoundingClientRect();
      const marker = [
        el.getAttribute('src'),
        el.getAttribute('title'),
        el.getAttribute('name'),
        el.getAttribute('id'),
        el.getAttribute('class'),
        el.outerHTML.slice(0, 500),
      ].filter((part) => part).join(' ');
      return {
        marker,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
      };
    });
    const turnstileFrames = visibleFrames.filter((frame) => (
      /cloudflare|turnstile|challenge|cf-|verify|human/i.test(frame.marker) ||
      (frame.width >= 180 && frame.height >= 45 && frame.height <= 120)
    )).length;
    const turnstileContainers = Array.from(document.querySelectorAll('div')).filter((el) => {
      const text = (el.textContent || '').trim();
      const html = el.outerHTML || '';
      return !text && /turnstile|cf-turnstile|challenges\.cloudflare\.com/i.test(html);
    }).map((el) => {
      const rect = el.getBoundingClientRect();
      return {
        marker: (el.outerHTML || '').slice(0, 500),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        visible: visible(el),
      };
    });
    const buttons = Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]')).map((el) => ({
      text: buttonLabel(el),
      disabled: Boolean(el.disabled) || el.getAttribute('aria-disabled') === 'true',
      visible: visible(el),
    }));
    const scanButtons = buttons.filter((b) => /^(scan|check)\s+for\s+ai$/i.test(b.text) && b.visible);
    return {
      turnstileFrames,
      turnstileContainers: turnstileContainers.length,
      turnstileContainerBoxes: turnstileContainers,
      visibleFrames,
      verifyText: /verify you are human/i.test(body),
      scanButtons,
      enabledScan: scanButtons.some((b) => !b.disabled),
    };
  }); // allow-raw-playwright: read-only public checker state
}

async function clickPublicTurnstileIfPresent(page) {
  const selectors = [
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
    'iframe[title*="Cloudflare" i]',
    'iframe[title*="challenge" i]',
    'iframe[title*="security" i]',
    'iframe[name*="cf" i]',
    'iframe[id*="cf" i]',
    'iframe[class*="cf" i]',
    'iframe',
    '.cf-turnstile',
    '[class*="turnstile" i]',
    '[id*="turnstile" i]',
    '[data-sitekey]',
    '[data-callback]',
    'xpath=//input[@name="cf-turnstile-response"]/ancestor::div[1]',
    'xpath=//input[@name="cf-turnstile-response"]/ancestor::div[2]',
    'xpath=//input[contains(@id, "cf-chl-widget")]/ancestor::div[1]',
    'xpath=//input[contains(@id, "cf-chl-widget")]/ancestor::div[2]',
    'div',
  ];

  const tried = [];
  for (const selector of selectors) {
    const elements = page.locator(selector);
    const count = await elements.count();
    const maxCandidates = selector === 'div' ? 250 : 8;
    for (let i = 0; i < Math.min(count, maxCandidates); i++) {
      const elementLocator = elements.nth(i);
      const box = await elementLocator.boundingBox();
      const visible = await elementLocator.isVisible().catch(() => false);
      if (!visible || !box || box.width < 80 || box.height < 30) continue;

      const title = await elementLocator.getAttribute('title');
      const src = await elementLocator.getAttribute('src');
      const html = await elementLocator.evaluate((el) => {
        const outer = el.outerHTML;
        if (!outer) return '';
        return outer.slice(0, 800);
      });
      const marker = [selector, title, src, html].filter((part) => part).join(' ');
      const markerLooksRelevant = /cloudflare|turnstile|challenge|verify|human/i.test(marker);
      const sizeLooksLikeWidget = box.width >= 120 && box.width <= 520 && box.height >= 30 && box.height <= 180;
      const looksRelevant = selector.startsWith('iframe')
        ? (markerLooksRelevant || (box.width >= 180 && box.height >= 45 && box.height <= 120))
        : (markerLooksRelevant && sizeLooksLikeWidget);
      if (!looksRelevant) continue;

      tried.push({
        selector,
        title: title?.slice(0, 120),
        src: src?.slice(0, 160),
        box: {
          x: Math.round(box.x),
          y: Math.round(box.y),
          width: Math.round(box.width),
          height: Math.round(box.height),
        },
      });

      const handle = await elementLocator.elementHandle();
      const frame = handle && selector.startsWith('iframe')
        ? await handle.contentFrame?.()
        : null;
      if (frame) {
        const insideWidget = [
          frame.getByRole('checkbox', { name: /verify|human/i }).first(),
          frame.locator('[role="checkbox"]').first(),
          frame.locator('input[type="checkbox"]').first(),
          frame.locator('label').first(),
        ];
        for (const target of insideWidget) {
          const visibleTarget = await target.isVisible().catch(() => false);
          const targetBox = await target.boundingBox();
          if (!visibleTarget || !targetBox) continue;
          await humanClickLocator(page, target);
          await page.waitForTimeout(3000);
          return { clicked: true, method: 'frame_locator', tried };
        }
      }

      const targetX = box.x + Math.min(Math.max(26, Math.round(box.width * 0.12)), Math.max(8, box.width - 10));
      const targetY = box.y + Math.min(Math.max(22, Math.round(box.height * 0.5)), Math.max(8, box.height - 8));
      await humanMove(page, targetX, targetY).catch(() => page.mouse.move(targetX, targetY)); // allow-raw-playwright: bounded coordinate path into the cross-origin Turnstile iframe
      await page.mouse.click(targetX, targetY); // allow-raw-playwright: click exact checkbox region inside visible Turnstile widget
      await page.waitForTimeout(3000);
      return { clicked: true, method: selector.startsWith('iframe') ? 'iframe_coordinate' : 'container_coordinate', tried };
    }
  }

  return { clicked: false, method: 'not_found', tried };
}

export async function waitForPublicVerificationIfNeeded(page) {
  let state = await publicVerificationState(page);
  if (!state.turnstileFrames && !state.turnstileContainers && !state.verifyText && (!state.scanButtons?.length || state.enabledScan)) return state;
  let turnstileClick = null;
  const deadline = Date.now() + Number(
    process.env.PANGRAM_WAIT_FOR_HUMAN_VERIFICATION === '1'
      ? process.env.PANGRAM_HUMAN_VERIFICATION_TIMEOUT_MS || 180_000
      : process.env.PANGRAM_PUBLIC_READY_TIMEOUT_MS || 30_000,
  );

  while (Date.now() < deadline) {
    if (state.enabledScan) return state;
    if (process.env.PANGRAM_CLICK_PUBLIC_TURNSTILE !== '0') {
      const click = await clickPublicTurnstileIfPresent(page);
      if (click.clicked || !turnstileClick) turnstileClick = click;
    }
    await page.waitForTimeout(1000);
    state = await publicVerificationState(page);
    if (turnstileClick) state.turnstileClick = turnstileClick;
    if (state.enabledScan) return state;
  }

  if (turnstileClick) state.turnstileClick = turnstileClick;
  return state;
}
