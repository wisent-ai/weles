import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Minimal page interface — any object that exposes a CDP-compatible screenshot. */
export interface ScreenshottablePage {
  screenshot?(options?: { type?: string }): Promise<Buffer>;
  /** Raw CDP send for pages backed by CDPConnection. */
  send?(method: string, params?: Record<string, any>): Promise<any>;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function visionDir(): string {
  const dir = join(process.cwd(), 'recordings', 'vision');
  mkdirSync(dir, { recursive: true });
  return dir;
}

async function takeScreenshot(page: ScreenshottablePage): Promise<Buffer | null> {
  try {
    if (typeof page.screenshot === 'function') {
      return await page.screenshot({ type: 'png' });
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

function askClaude(screenshot: Buffer, question: string): string {
  const imgPath = join(visionDir(), 'vision_query.png');
  writeFileSync(imgPath, screenshot);

  const prompt = `Read the image file at ${imgPath}. Then answer: ${question}`;

  const raw = execSync(
    `claude -p --output-format json ${JSON.stringify(prompt)}`,
    {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 120_000,
    },
  );

  try {
    const parsed = JSON.parse(raw);
    return String(parsed.result ?? parsed.content ?? parsed.text ?? raw).trim();
  } catch {
    return raw.trim();
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Screenshot the page and ask Claude an open-ended question about it.
 */
export async function askPage(page: ScreenshottablePage, question: string): Promise<string> {
  const screenshot = await takeScreenshot(page);
  if (!screenshot) {
    throw new Error('Failed to capture screenshot from page');
  }
  return askClaude(screenshot, question);
}

/**
 * Ask a yes/no question about the page. Returns `true` if the answer starts
 * with "YES".
 */
export async function checkPage(page: ScreenshottablePage, question: string): Promise<boolean> {
  const answer = await askPage(page, `Answer only YES or NO. ${question}`);
  return answer.toUpperCase().startsWith('YES');
}

/**
 * Identify the kind of page currently displayed (e.g. login_page, dashboard,
 * captcha_challenge, error_page, etc.).
 */
export async function identifyPage(page: ScreenshottablePage): Promise<string> {
  return askPage(
    page,
    'What type of page is this? Reply with one short label such as login_page, dashboard, captcha_challenge, error_page, search_results, form, landing_page, etc.',
  );
}

/**
 * Ask Claude to locate a UI element matching `description` and return its
 * coordinates.  Returns `null` when the element cannot be found.
 */
export async function findClickTarget(
  page: ScreenshottablePage,
  description: string,
): Promise<{ x: number; y: number } | null> {
  const answer = await askPage(
    page,
    `Find the element that matches: "${description}". Return its center coordinates as JSON: {"x": <number>, "y": <number>}. If you cannot find it, reply with null.`,
  );

  try {
    const match = answer.match(/\{[\s\S]*?"x"\s*:\s*\d[\s\S]*?"y"\s*:\s*\d[\s\S]*?\}/);
    if (match) {
      const coords = JSON.parse(match[0]);
      if (typeof coords.x === 'number' && typeof coords.y === 'number') {
        return { x: coords.x, y: coords.y };
      }
    }
  } catch {
    // parse failure — element not found
  }

  return null;
}
