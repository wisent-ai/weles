import { humanMove } from '../../../../dist/human/mouse.js';
import { humanRandom } from '../../../../dist/utils/motion/timing.js';
import { pageCondition, pageSettled } from '../../_shared/page/settled.mjs';

const MODAL =
  '.captcha-verify-container, .captcha_verify_container, [class*="captcha-"]';
/** The draggable handle, by the classes TikTok's captcha SDK gives it. */
const HANDLE =
  '.secsdk-captcha-drag-icon, [class*="drag-icon"], [class*="slide-button"]';

/**
 * Resolves once the captcha modal shows its two puzzle images, loaded and
 * drawn, checked in the page every frame.
 */
async function waitForPuzzleImages(page) {
  await pageCondition(
    page,
    (modalSelector) => {
      const m = document.querySelector(modalSelector);
      if (!m) return false;
      const drawn = Array.from(m.querySelectorAll('img')).filter((i) => {
        const r = i.getBoundingClientRect();
        return i.complete && r.width && r.height && i.src.startsWith('data:');
      });
      const [, inner] = drawn;
      return inner !== undefined;
    },
    MODAL,
  );
}

/**
 * The two puzzle images (the larger is the outer ring), the slider handle and
 * the track it slides along, as the modal lays them out. A modal without
 * one of them is refused naming what it lacks.
 */
async function probePuzzle(page) {
  const probe = await page.evaluate(
    ({ modalSelector, handleSelector }) => {
      const box = (element) => {
        const r = element.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      };
      const modal = document.querySelector(modalSelector);
      if (!modal) return { missing: 'the captcha modal' };
      const [outer, inner] = Array.from(modal.querySelectorAll('img'))
        .filter((i) => i.src.startsWith('data:'))
        .map((i) => ({ src: i.src, ...box(i) }))
        .sort((a, b) => b.w - a.w);
      if (inner === undefined) return { missing: 'two puzzle images' };
      const handle = modal.querySelector(handleSelector);
      if (!handle) return { missing: `a slider handle (${handleSelector})` };
      const slider = box(handle);
      // The track is the handle's nearest ancestor wider than the handle:
      // the strip the handle slides along.
      let track = null;
      for (
        let p = handle.parentElement;
        p && p !== modal;
        p = p.parentElement
      ) {
        if (box(p).w > slider.w) {
          track = box(p);
          break;
        }
      }
      if (!track) return { missing: 'a slider track wider than its handle' };
      // Degrees in one full turn, as CSS converts a turn to degrees.
      const turnDegrees = CSSNumericValue.parse('1turn').to('deg').value;
      return { outer, inner, slider, track, turnDegrees };
    },
    { modalSelector: MODAL, handleSelector: HANDLE },
  );
  if (probe.missing)
    throw new Error(
      `tiktok_captcha_unreadable: the captcha shows no ${probe.missing}`,
    );
  return probe;
}

/** The rotation SadCaptcha reads from the two puzzle images, in degrees; a failed or empty answer is refused with its cause. */
async function rotationAngle(apiKey, probe) {
  // The images go without their data:image/...;base64, prefix.
  const stripPrefix = (u) => u.replace(/^data:[^,]+,/, '');
  const resp = await fetch(
    `https://www.sadcaptcha.com/api/v1/rotate?licenseKey=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outerImageB64: stripPrefix(probe.outer.src),
        innerImageB64: stripPrefix(probe.inner.src),
      }),
    },
  );
  const text = await resp.text();
  if (!resp.ok)
    throw new Error(
      `tiktok_captcha_solver_refused: SadCaptcha rotate answered HTTP ${resp.status}: ${text}`,
    );
  const answer = JSON.parse(text);
  if (typeof answer?.angle !== 'number' || !Number.isFinite(answer.angle))
    throw new Error(
      `tiktok_captcha_solver_unreadable: SadCaptcha rotate answered no angle: ${text}`,
    );
  console.log(`[tt-captcha] sadcaptcha returned angle=${answer.angle}`);
  return answer.angle;
}

/**
 * Drag the slider handle `dragX` pixels along its track: press at a point on
 * the handle (drawn from the run's seeded timing source, as a hand lands
 * anywhere on it), move along the shared human pointer path, release.
 */
async function dragSlider(page, slider, dragX) {
  const startX = slider.x + slider.w * humanRandom();
  const startY = slider.y + slider.h * humanRandom();
  await humanMove(page, startX, startY);
  await page.mouse.down();
  await humanMove(page, startX + dragX, startY, startX, startY);
  await page.mouse.up();
}

/**
 * Solve TikTok rotate captcha via SadCaptcha API.
 * Returns true if the captcha was solved and dismissed, false when the modal
 * stays after the drag; a captcha or an answer that cannot be read is
 * refused with its cause.
 */
export async function solveTiktokRotateCaptcha(page) {
  const apiKey = process.env.SADCAPTCHA_API_KEY;
  if (!apiKey)
    throw new Error(
      'tiktok_captcha_solver_unconfigured: SADCAPTCHA_API_KEY is not set, so the rotate captcha cannot be solved',
    );
  await waitForPuzzleImages(page);
  const probe = await probePuzzle(page);
  console.log(
    `[tt-captcha] outer=${probe.outer.w}x${probe.outer.h} inner=${probe.inner.w}x${probe.inner.h} slider=${probe.slider.w}x${probe.slider.h} track=${probe.track.w}x${probe.track.h}`,
  );
  const angle = await rotationAngle(apiKey, probe);
  // SadCaptcha's rotate formula: the handle travels the track's free length
  // in proportion to the angle's share of a full turn.
  const dragX = ((probe.track.w - probe.slider.w) * angle) / probe.turnDegrees;
  console.log(
    `[tt-captcha] dragging slider by ${dragX}px (trackW=${probe.track.w} btnW=${probe.slider.w})`,
  );
  await dragSlider(page, probe.slider, dragX);
  // The verdict is the modal being removed (solved) or TikTok answering the
  // verify request with a failure; the modal's state once the page has settled
  // after the drag says which.
  await pageSettled(page);
  const stillThere = await page.evaluate(
    () =>
      !!document.querySelector(
        '.captcha-verify-container, .captcha_verify_container',
      ),
  );
  if (!stillThere) {
    console.log('[tt-captcha] modal dismissed — captcha solved');
    return true;
  }
  console.log(
    '[tt-captcha] tiktok_captcha_unsolved: modal still present after drag',
  );
  return false;
}
