import { humanIdlePause } from '../../../../dist/human/mouse.js';

const MODAL = '.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]';

/** Wait until the captcha modal shows at least two loaded images (up to ~12s). */
async function waitForPuzzleImages(page) {
  for (let w = 0; w < 24; w++) {
    const ready = await page.evaluate((modalSelector) => {
      const m = document.querySelector(modalSelector);
      if (!m) return false;
      const imgs = Array.from(m.querySelectorAll('img')).filter((i) => {
        const r = i.getBoundingClientRect();
        return r.width > 50 && r.height > 50 && i.src && i.src.startsWith('data:');
      });
      return imgs.length >= 2;
    }, MODAL).catch(() => false);
    if (ready) return;
    await humanIdlePause('short');
  }
}

/** Extract the two puzzle images, the slider button and its track from the modal. */
function probePuzzle(page) {
  return page.evaluate((modalSelector) => {
    const modal = document.querySelector(modalSelector);
    if (!modal) return null;
    const imgs = Array.from(modal.querySelectorAll('img'))
      .map((i) => {
        const r = i.getBoundingClientRect();
        return { src: i.src, w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y), alt: i.alt };
      })
      .filter((m) => m.w > 0 && m.h > 0);
    if (imgs.length < 2) return { reason: 'fewer than 2 images', imgs };
    // Outer = larger, inner = smaller
    imgs.sort((a, b) => b.w - a.w);
    const outer = imgs[0];
    const inner = imgs[1];
    // Slider button (the draggable handle, usually has secsdk-captcha-drag-icon class
    // or is a button inside the modal at the bottom).
    const sliderBtn = modal.querySelector('.secsdk-captcha-drag-icon, [class*="drag-icon"], [class*="slide-button"]');
    let sliderInfo = null;
    if (sliderBtn) {
      const r = sliderBtn.getBoundingClientRect();
      sliderInfo = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    } else {
      // Without a recognisable handle, the lowest button inside the modal is the handle.
      const buttons = Array.from(modal.querySelectorAll('button')).filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width > 20 && r.height > 20;
      });
      buttons.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y);
      const cand = buttons[0];
      if (cand) {
        const r = cand.getBoundingClientRect();
        sliderInfo = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }
    }
    // Slider track — walk up parents until we find one significantly wider
    // than the button (the visual track typically spans the captcha modal
    // width: ~280px on standard TikTok rotate).
    let trackInfo = null;
    if (sliderBtn) {
      let p = sliderBtn.parentElement;
      while (p && p !== modal) {
        const r = p.getBoundingClientRect();
        if (r.width >= sliderInfo.w * 2 && r.height < 80) {
          trackInfo = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          break;
        }
        p = p.parentElement;
      }
    }
    return { outer, inner, sliderInfo, trackInfo };
  }, MODAL).catch((e) => ({ err: e.message }));
}

/** Ask SadCaptcha for the rotation angle of the two puzzle images; 0 when it gave none. */
async function rotationAngle(apiKey, probe) {
  // Strip the data:image/...;base64, prefix from the image URLs.
  const stripPrefix = (u) => u.replace(/^data:[^,]+,/, '');
  try {
    const resp = await fetch(`https://www.sadcaptcha.com/api/v1/rotate?licenseKey=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outerImageB64: stripPrefix(probe.outer.src), innerImageB64: stripPrefix(probe.inner.src) }),
    });
    if (!resp.ok) {
      const txt = await resp.text();
      console.log(`[tt-captcha] sadcaptcha api status=${resp.status} body=${txt.slice(0, 200)}`);
      return 0;
    }
    const j = await resp.json();
    const angle = Number(j?.angle ?? 0);
    console.log(`[tt-captcha] sadcaptcha returned angle=${angle}`);
    return angle;
  } catch (e) {
    console.log(`[tt-captcha] sadcaptcha api error: ${e.message}`);
    return 0;
  }
}

/** Drag the slider button by dragX pixels in eased, jittered steps. */
async function dragSlider(page, sliderInfo, dragX) {
  const startX = sliderInfo.x + Math.floor(sliderInfo.w / 2);
  const startY = sliderInfo.y + Math.floor(sliderInfo.h / 2);
  await page.mouse.move(startX, startY, { steps: 5 });
  await humanIdlePause('short');
  await page.mouse.down();
  // Move in 30 small steps over ~1.5s, with slight Y jitter.
  const steps = 30;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Ease-out: most movement early, slight tail
    const ease = 1 - Math.pow(1 - t, 2);
    const x = startX + Math.round(dragX * ease);
    const y = startY + (Math.random() < 0.3 ? (Math.random() < 0.5 ? -1 : 1) : 0);
    await page.mouse.move(x, y);
    await humanIdlePause();
  }
  await humanIdlePause('short');
  await page.mouse.up();
}

/**
 * Solve TikTok rotate captcha via SadCaptcha API.
 * Returns true if captcha solved + dismissed, false otherwise.
 */
export async function solveTiktokRotateCaptcha(page) {
  const apiKey = process.env.SADCAPTCHA_API_KEY;
  if (!apiKey) { console.log('[tt-captcha] SADCAPTCHA_API_KEY missing — cannot solve'); return false; }
  await waitForPuzzleImages(page);
  const probe = await probePuzzle(page);
  if (!probe || probe.err || !probe.outer || !probe.inner || !probe.sliderInfo) {
    console.log(`[tt-captcha] probe failed: ${JSON.stringify(probe)}`);
    return false;
  }
  console.log(`[tt-captcha] outer=${probe.outer.w}x${probe.outer.h} inner=${probe.inner.w}x${probe.inner.h} slider=${probe.sliderInfo.w}x${probe.sliderInfo.h} track=${probe.trackInfo?.w}x${probe.trackInfo?.h}`);
  const angle = await rotationAngle(apiKey, probe);
  if (!angle || isNaN(angle)) { console.log('[tt-captcha] zero/NaN angle'); return false; }
  // Calculate slider drag distance.
  // GitHub docs formula: result = ((slide_bar_width - slide_button_width) * angle) / 360
  // The track width in TikTok web rotate is the inner image width (~280px on
  // mobile, varies on desktop). Use the parent container width as approx.
  const trackWidth = probe.trackInfo?.w ?? 280;
  const buttonWidth = probe.sliderInfo.w;
  const dragX = Math.round(((trackWidth - buttonWidth) * angle) / 360);
  console.log(`[tt-captcha] dragging slider by ${dragX}px (trackW=${trackWidth} btnW=${buttonWidth})`);
  await dragSlider(page, probe.sliderInfo, dragX);
  // Wait up to 5s for the modal to disappear.
  for (let w = 0; w < 10; w++) {
    await humanIdlePause('short');
    const stillThere = await page.evaluate(() => !!document.querySelector('.captcha-verify-container, .captcha_verify_container')).catch(() => true);
    if (!stillThere) {
      console.log('[tt-captcha] modal dismissed — captcha solved');
      return true;
    }
  }
  console.log('[tt-captcha] modal still present after drag — solve failed');
  return false;
}
