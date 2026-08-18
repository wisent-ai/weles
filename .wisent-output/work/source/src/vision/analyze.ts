import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pruneRecordings } from '../prune.js';
import { runRecordingsDir } from '../session/run-recordings.js';
import { parseXY, parseElements, filterElements, centerCrop } from './escalation.js';
import { callJeden } from '../agent/jeden.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal page interface — any object that exposes a CDP-compatible screenshot. */
export interface ScreenshottablePage {
  screenshot?(options?: { type?: string }): Promise<Buffer>;
  /** Raw CDP send for pages backed by CDPConnection. */
  send?(method: string, params?: Record<string, any>): Promise<any>;
  /** Optional evaluate for DOM context. */
  evaluate?(expression: string): Promise<any>;
}

// ---------------------------------------------------------------------------
// VisionRefusedError
// ---------------------------------------------------------------------------

const REFUSAL_MARKERS = [
  "i'm not going to",
  "i won't",
  "i cannot help",
  "i can't help",
  "i'm not able to",
  "outside the scope",
  "i don't feel comfortable",
  "i'm unable to assist",
  "cannot assist with",
  "can't assist with",
  "i need to pause",
  "bypass",
];

function isRefusal(answer: string): boolean {
  const low = answer.toLowerCase();
  return REFUSAL_MARKERS.some(m => low.includes(m));
}

export class VisionRefusedError extends Error {
  question: string;
  answer: string;
  constructor(question: string, answer: string) {
    super(`Jeden refused vision query. Question: ${question.slice(0, 200)}. Answer: ${answer.slice(0, 300)}`);
    this.question = question;
    this.answer = answer;
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

const VISION_TIMEOUT_MS = 2 * 60 * 1000;

function visionDir(): string {
  const dir = process.env.WELES_VISION_DIR ?? runRecordingsDir('vision'); // G17: recordings/<run_uuid>/vision/
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function takeScreenshot(page: ScreenshottablePage): Promise<Buffer | null> {
  try {
    if (typeof page.screenshot === 'function') {
      try {
        return await (page as any).screenshot({ type: 'png', scale: 'css' });
      } catch {
        return await page.screenshot({ type: 'png' });
      }
    }
    if (typeof page.send === 'function') {
      const result = await page.send('Page.captureScreenshot', { format: 'png' });
      if (result?.data) {
        return Buffer.from(result.data, 'base64');
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function askJedenAboutImage(screenshot: Buffer, question: string, tier = 'tier_0_bare', domHtml = ''): Promise<string> {
  const dir = visionDir();
  const ts = new Date().toISOString().replace(/[:.]/g, '_');
  const imgPath = join(dir, `vision_${ts}_${tier}.png`);
  const logPath = join(dir, `vision_${ts}_${tier}.json`);
  writeFileSync(imgPath, screenshot);

  if (domHtml) {
    try {
      writeFileSync(join(dir, `vision_${ts}_${tier}.dom.html`), domHtml);
    } catch { /* skip */ }
  }

  let answer = '';
  let error: string | null = null;
  try {
    const prompt = `Read the image file at ${imgPath}, then answer the question below. Use the DOM snapshot at ${join(dir, `vision_${ts}_${tier}.dom.html`)} only as supporting context when it exists. Return only the answer.\n\n${question}`;
    answer = (await callJeden(prompt, { modelOnly: false, maxSteps: Number('4'), timeoutMs: VISION_TIMEOUT_MS })).raw;
  } catch (e: any) {
    error = String(e);
    answer = '';
  }

  try {
    writeFileSync(logPath, JSON.stringify({
      timestamp: ts, tier, image: imgPath.split('/').pop(),
      question, answer, error,
    }, null, 2));
  } catch { /* skip */ }

  // Prune vision dir to stay under budget
  try {
    const budget = parseInt(process.env.WELES_VISION_MAX_BYTES ?? String(500 * 1024 * 1024), 10);
    pruneRecordings(dir, budget);
  } catch { /* skip */ }

  return answer;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Screenshot the page and ask Jeden an open-ended question about it.
 * Raises VisionRefusedError on safety refusal.
 */
export async function askPage(
  page: ScreenshottablePage,
  question: string,
  imageBytes?: Buffer | null,
  tier = 'tier_0_bare',
): Promise<string> {
  const screenshot = imageBytes ?? await takeScreenshot(page);
  if (!screenshot) {
    throw new Error('Failed to capture screenshot from page');
  }
  // Grab DOM context when available
  let domHtml = '';
  try {
    if (typeof (page as any).evaluate === 'function') {
      domHtml = await (page as any).evaluate('document.documentElement.outerHTML') ?? '';
    }
  } catch { /* skip */ }

  const answer = await askJedenAboutImage(screenshot, question, tier, domHtml);
  if (isRefusal(answer)) {
    throw new VisionRefusedError(question, answer);
  }
  return answer;
}

/**
 * Ask a yes/no question about the page. Returns `true` if the answer starts
 * with "YES".
 */
export async function checkPage(page: ScreenshottablePage, question: string): Promise<boolean> {
  const answer = await askPage(page, `${question} Answer only YES or NO.`);
  return answer.toUpperCase().startsWith('YES');
}

/**
 * Identify the kind of page currently displayed.
 */
export async function identifyPage(page: ScreenshottablePage): Promise<string> {
  return askPage(
    page,
    'What type of page is this? Answer with exactly one of: '
    + 'login_page, dashboard, captcha_challenge, error_page, '
    + 'verification_required, signup_page, success_page, '
    + 'loading, blocked, or unknown. Just the label, nothing else.',
  );
}

/**
 * Locate a click target via vision with multi-tier escalation.
 *
 *   tier_0_bare      bare question on the full screenshot
 *   tier_1_crop      same question on a centred crop (removes context)
 *   tier_2_decompose enumerate all visible UI controls, filter by description
 *
 * Raises VisionRefusedError only if every tier refuses. Returns null
 * if every tier answered but produced no parseable coordinates.
 */
export async function findClickTarget(
  page: ScreenshottablePage,
  description: string,
): Promise<{ x: number; y: number } | null> {
  const full = await takeScreenshot(page);
  if (!full) return null;

  // Resize to a known width so model-returned coordinates remain predictable
  // even when the routed vision backend applies its own image scaling.
  const VISION_WIDTH = 768;
  let resized = full;
  let scaleX = 1, scaleY = 1;
  try {
    const sharp = (await import('sharp')).default;
    const meta = await sharp(full).metadata();
    const origW = meta.width ?? 1920;
    const origH = meta.height ?? 1080;
    if (origW > VISION_WIDTH) {
      const newH = Math.round(origH * VISION_WIDTH / origW);
      resized = await sharp(full).resize(VISION_WIDTH, newH).png().toBuffer();
      scaleX = origW / VISION_WIDTH;
      scaleY = origH / newH;
    }
  } catch { /* use original */ }

  const bareQ = (
    `I need to click: ${description}. `
    + 'Return the x,y pixel coordinates of where to click as JSON: '
    + '{"x": <number>, "y": <number>}. Only the JSON, nothing else.'
  );
  const refusals: Array<[string, string]> = [];

  function scaleResult(r: { x: number; y: number }): { x: number; y: number } {
    return { x: Math.round(r.x * scaleX), y: Math.round(r.y * scaleY) };
  }

  // Tier 0 — bare question on resized screenshot
  try {
    const ans = await askPage(page, bareQ, resized, 'tier_0_bare');
    const result = parseXY(ans);
    if (result) return scaleResult(result);
  } catch (e) {
    if (e instanceof VisionRefusedError) {
      console.log('  [vision] tier_0_bare refused, escalating');
      refusals.push(['tier_0_bare', String(e).slice(0, 300)]);
    } else throw e;
  }

  // Tier 1 — centre crop of resized image
  const { cropped, offsetX, offsetY } = await centerCrop(resized);
  if (cropped) {
    try {
      const ans = await askPage(page, bareQ, cropped, 'tier_1_crop');
      const result = parseXY(ans);
      if (result) return scaleResult({ x: result.x + offsetX, y: result.y + offsetY });
    } catch (e) {
      if (e instanceof VisionRefusedError) {
        console.log('  [vision] tier_1_crop refused, escalating');
        refusals.push(['tier_1_crop', String(e).slice(0, 300)]);
      } else throw e;
    }
  } else {
    console.log('  [vision] tier_1_crop unavailable (no sharp); skipping');
  }

  // Tier 2 — decompose all UI controls
  const decompQ = (
    'List every interactive UI control visible in this image. '
    + 'Return ONLY a JSON array, no prose, where each element has '
    + '"label" (visible text or description), "x" (centre x in pixels), '
    + '"y" (centre y in pixels). Example: '
    + '[{"label": "Submit button", "x": 400, "y": 300}]'
  );
  try {
    const ans = await askPage(page, decompQ, resized, 'tier_2_decompose');
    const elements = parseElements(ans);
    const match = filterElements(elements, description);
    if (match) return scaleResult(match);
  } catch (e) {
    if (e instanceof VisionRefusedError) {
      console.log('  [vision] tier_2_decompose refused');
      refusals.push(['tier_2_decompose', String(e).slice(0, 300)]);
    } else throw e;
  }

  if (refusals.length === 3) {
    throw new VisionRefusedError(description, `All 3 vision tiers refused: ${JSON.stringify(refusals)}`);
  }
  return null;
}
