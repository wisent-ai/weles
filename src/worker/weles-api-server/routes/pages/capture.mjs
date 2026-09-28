// What a page route does inside the browser: open one guarded context, load
// the admitted page to the load state the caller named, and either read it
// (snapshot) or fill its form and take the file it downloads (form export).
//
// Products that need a rendered page at request time call these routes instead
// of launching their own browser: the reading of structure, design tokens and
// forms below is the one echo-web's competitor research ran in its own
// puppeteer, moved here unchanged so its results stay comparable. A download
// is taken through Playwright's download event, so a page that exports a blob
// through a generated anchor is captured without patching the page.

import { readFile } from 'node:fs/promises';

import {
  FULL_SCREENSHOT,
  MAX_DOWNLOAD_BYTES,
  MAX_ITEMS,
  MAX_PALETTE,
  MAX_SCREENSHOT_BYTES,
  MAX_TEXT_BYTES,
  NO_SCREENSHOT,
  SCREENSHOT_JPEG_QUALITY,
} from './constants.mjs';
import { admitPublicTarget, guardContext } from './network.mjs';

const TEXT_START = 0;
const NONE_FOUND = 0;

export class PageLoadFailed extends Error {
  constructor(message) {
    super(message);
    this.name = 'PageLoadFailed';
  }
}

function truncateUtf8(value, maxBytes) {
  const buffer = Buffer.from(value, 'utf8');
  if (buffer.byteLength <= maxBytes) return value;
  return buffer.subarray(TEXT_START, maxBytes).toString('utf8');
}

async function withLoadedPage({ openBrowser, publicAddresses }, request, work) {
  const target = await admitPublicTarget(request.url, publicAddresses);
  const context = await openBrowser({ headless: true, ...(request.userAgent ? { userAgent: request.userAgent } : {}) });
  try {
    const refused = await guardContext(context, publicAddresses);
    const page = await context.newPage();
    await page.setViewportSize(request.viewport);
    const response = await page.goto(target.href, { waitUntil: request.loadState });
    if (!response) throw new PageLoadFailed(`no navigation response for ${target.href}`);
    if (!response.ok()) throw new PageLoadFailed(`HTTP ${response.status()} for ${target.href}`);
    const result = await work(page);
    return {
      ...result,
      final_url: page.url(),
      status: response.status(),
      viewport: request.viewport,
      load_state: request.loadState,
      refused_requests: refused,
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

function readStructure({ maxItems, maxPalette }) {
  const start = 0;
  const clean = (value) => (value || '').replace(/\s+/g, ' ').trim();
  const visible = (element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > start && rect.height > start;
  };
  const meta = (selector) => document.querySelector(selector)?.content || '';
  const textOf = (selector) => Array.from(document.querySelectorAll(selector))
    .filter(visible).map((element) => clean(element.textContent)).filter(Boolean).slice(start, maxItems);
  const linkOf = (selector) => Array.from(document.querySelectorAll(selector))
    .filter(visible).map((element) => ({ text: clean(element.textContent), href: element.href }))
    .filter((entry) => entry.text || entry.href).slice(start, maxItems);
  const sampled = Array.from(document.querySelectorAll('body *')).filter(visible).slice(start, maxItems);
  const styles = sampled.map((element) => window.getComputedStyle(element));
  const unique = (values) => Array.from(new Set(values.filter((value) => value && value !== 'rgba(0, 0, 0, 0)')))
    .slice(start, maxPalette);
  const forms = Array.from(document.querySelectorAll('form')).slice(start, maxItems).map((form) => ({
    action: form.action,
    method: form.method,
    fields: Array.from(form.querySelectorAll('input,select,textarea')).slice(start, maxItems).map((field) => ({
      name: field.name,
      type: field instanceof HTMLInputElement ? field.type : field.tagName.toLowerCase(),
      placeholder: 'placeholder' in field ? field.placeholder : '',
      required: field.required,
    })),
  }));
  return {
    text: clean(document.body?.innerText),
    structured: {
      title: document.title,
      description: meta('meta[name="description"]'),
      canonical: document.querySelector('link[rel="canonical"]')?.href || '',
      language: document.documentElement.lang || '',
      robots: meta('meta[name="robots"]'),
      openGraph: {
        title: meta('meta[property="og:title"]'),
        description: meta('meta[property="og:description"]'),
        image: meta('meta[property="og:image"]'),
      },
      twitterCard: meta('meta[name="twitter:card"]'),
      jsonLdCount: document.querySelectorAll('script[type="application/ld+json"]').length,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      headings: textOf('h1,h2,h3'),
      headingOutline: Array.from(document.querySelectorAll('h1,h2,h3')).filter(visible)
        .map((element) => ({ level: element.tagName.toLowerCase(), text: clean(element.textContent) }))
        .filter((heading) => heading.text).slice(start, maxItems),
      navigation: linkOf('nav a, header a'),
      callsToAction: textOf('button,[role="button"],a[class*="button"],a[class*="cta"]'),
      forms,
      landmarks: Array.from(document.querySelectorAll('header,nav,main,aside,footer,section')).slice(start, maxItems)
        .map((element) => ({
          tag: element.tagName.toLowerCase(),
          label: clean(element.getAttribute('aria-label') || element.querySelector('h1,h2,h3')?.textContent),
        })),
      designTokens: {
        fonts: unique(styles.map((style) => style.fontFamily)),
        textColors: unique(styles.map((style) => style.color)),
        backgroundColors: unique(styles.map((style) => style.backgroundColor)),
        fontSizes: unique(styles.map((style) => style.fontSize)),
        borderRadii: unique(styles.map((style) => style.borderRadius)),
      },
    },
  };
}

async function screenshotOf(page, mode) {
  if (mode === NO_SCREENSHOT) return null;
  let image = await page.screenshot({ type: 'jpeg', quality: SCREENSHOT_JPEG_QUALITY, fullPage: mode === FULL_SCREENSHOT });
  let taken = mode;
  if (image.byteLength > MAX_SCREENSHOT_BYTES && mode === FULL_SCREENSHOT) {
    image = await page.screenshot({ type: 'jpeg', quality: SCREENSHOT_JPEG_QUALITY, fullPage: false });
    taken = 'viewport';
  }
  if (image.byteLength > MAX_SCREENSHOT_BYTES) {
    return { requested: mode, content_type: 'image/jpeg', bytes: image.byteLength, embedded: false, omitted_reason: 'image_size_limit' };
  }
  return { requested: mode, taken, content_type: 'image/jpeg', bytes: image.byteLength, embedded: true, base64: image.toString('base64') };
}

/** The page as text, structure and, when asked, one JPEG. */
export function capturePageSnapshot(browser, request) {
  return withLoadedPage(browser, request, async (page) => {
    const extracted = await page.evaluate(readStructure, { maxItems: MAX_ITEMS, maxPalette: MAX_PALETTE });
    return {
      text: truncateUtf8(extracted.text, MAX_TEXT_BYTES),
      structured: extracted.structured,
      screenshot: await screenshotOf(page, request.screenshot),
    };
  });
}

const CONTENT_TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf' };

/** Fill the named fields, press the button with the exact text, return the file the page downloads. */
export function capturePageExport(browser, request) {
  return withLoadedPage(browser, request, async (page) => {
    for (const field of request.fields) {
      const input = page.locator(field.selector).first();
      if (await input.count() === NONE_FOUND) throw new PageLoadFailed(`no element matches ${field.selector}`);
      await input.fill(field.value);
    }
    const button = page.getByRole('button', { name: request.clickText, exact: true }).first();
    if (await button.count() === NONE_FOUND) throw new PageLoadFailed(`no button reads "${request.clickText}"`);
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    const failure = await download.failure();
    if (failure) throw new PageLoadFailed(`the page's download failed: ${failure}`);
    const bytes = await readFile(await download.path());
    if (bytes.byteLength > MAX_DOWNLOAD_BYTES) {
      throw new PageLoadFailed(`the page's download is ${bytes.byteLength} bytes, over ${MAX_DOWNLOAD_BYTES}`);
    }
    const name = download.suggestedFilename();
    const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
    return {
      filled: request.fields.map((field) => field.selector),
      clicked: request.clickText,
      download: {
        file_name: name,
        content_type: Object.hasOwn(CONTENT_TYPES, extension) ? CONTENT_TYPES[extension] : 'application/octet-stream',
        bytes: bytes.byteLength,
        base64: bytes.toString('base64'),
      },
    };
  });
}
