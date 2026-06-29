#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseDir = resolve(process.argv[2] || 'recordings/local/meta_ads_oauth_connect');
const domPath = resolve(baseDir, 'after_000_goto_oauth_client_id_9310_dom.html');
const harPath = resolve(baseDir, 'session.har');

function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = parsed.hash ? '#<redacted>' : '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/token|code|secret|state|lsd|jazoest|fb_dtsg|privacy_mutation_token/i.test(key)) {
        parsed.searchParams.set(key, '<redacted>');
      }
    }
    return parsed.toString();
  } catch {
    return '<invalid-url>';
  }
}

function sanitizePostData(text) {
  if (!text) return null;
  const params = new URLSearchParams(text);
  const keys = [...params.keys()];
  if (!keys.length) return { kind: 'raw', bytes: text.length };
  const values = {};
  for (const key of keys.slice(0, 40)) {
    const value = params.get(key) || '';
    values[key] = /token|code|secret|state|lsd|jazoest|fb_dtsg|privacy_mutation_token/i.test(key)
      ? '<redacted>'
      : value.slice(0, 120);
  }
  return { kind: 'form', keys: keys.slice(0, 80), values };
}

async function inspectDom() {
  if (!existsSync(domPath)) return { path: domPath, missing: true };
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent(readFileSync(domPath, 'utf8'), { waitUntil: 'domcontentloaded' });
  const data = await page.evaluate(() => {
    function textOf(el) {
      if (el instanceof HTMLInputElement) return (el.value || el.getAttribute('aria-label') || '').trim();
      return (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    }
    function visible(el) {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    }
    function describe(el) {
      const rect = el.getBoundingClientRect();
      const x = Math.round(rect.left + rect.width / 2);
      const y = Math.round(rect.top + rect.height / 2);
      const topmost = document.elementFromPoint(x, y);
      const form = el.closest('form');
      return {
        tag: el.tagName.toLowerCase(),
        text: textOf(el).slice(0, 140),
        role: el.getAttribute('role') || '',
        type: el.getAttribute('type') || '',
        href: el.getAttribute('href') || '',
        name: el.getAttribute('name') || '',
        id: el.id || '',
        visible: visible(el),
        disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
        center: { x, y },
        topmostTag: topmost?.tagName?.toLowerCase() || '',
        topmostText: topmost ? textOf(topmost).slice(0, 140) : '',
        form: form
          ? {
              method: form.getAttribute('method') || '',
              action: form.getAttribute('action') || '',
              id: form.id || '',
            }
          : null,
        outer: el.outerHTML.replace(/\s+/g, ' ').slice(0, 400),
      };
    }
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a, input[type="button"], input[type="submit"]'))
      .map(describe)
      .filter((item) => item.visible)
      .slice(0, 80);
    const forms = Array.from(document.querySelectorAll('form')).map((form) => ({
      method: form.getAttribute('method') || '',
      action: form.getAttribute('action') || '',
      id: form.id || '',
      text: textOf(form).slice(0, 240),
      inputs: Array.from(form.querySelectorAll('input')).map((input) => ({
        type: input.getAttribute('type') || '',
        name: input.getAttribute('name') || '',
        valuePresent: Boolean(input.value),
      })).slice(0, 60),
    })).slice(0, 20);
    return { title: document.title, bodyText: textOf(document.body).slice(0, 1000), controls, forms };
  });
  await browser.close();
  return { path: domPath, ...data };
}

function inspectHar() {
  if (!existsSync(harPath)) return { path: harPath, missing: true };
  const har = JSON.parse(readFileSync(harPath, 'utf8'));
  const entries = har.log.entries
    .filter((entry) => /facebook\.com|fbcdn\.net/i.test(entry.request.url))
    .map((entry) => ({
      startedDateTime: entry.startedDateTime,
      status: entry.response.status,
      method: entry.request.method,
      url: sanitizeUrl(entry.request.url),
      postData: sanitizePostData(entry.request.postData?.text || ''),
    }));
  return { path: harPath, entries: entries.slice(-120) };
}

console.log(JSON.stringify({
  dom: await inspectDom(),
  har: inspectHar(),
}, null, 2));
