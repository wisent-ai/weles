/**
 * Agent tool dispatch — each tool takes a CDPPage + args, returns a result string.
 * Tools are general-purpose. The LLM decides the sequence. No page-specific logic.
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
type CDPPage = any; // Works with both Playwright Page and CDPPage
import { findClickTarget, askPage, type ScreenshottablePage } from '../vision/analyze.js';

const asVision = (p: CDPPage) => p as unknown as ScreenshottablePage;

export type ToolArgs = Record<string, any>;
export type ToolFn = (page: CDPPage, args: ToolArgs) => Promise<string>;

// Env-like store for generated credentials (not actual process.env)
const _envStore: Record<string, string> = {};

function resolveEnv(value: string): string {
  return value.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (_, k) => _envStore[k] ?? process.env[k] ?? value);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function getUrl(page: any): string {
  try { return typeof page.url === 'function' ? page.url() : page.url; } catch { return ''; }
}

async function click(page: CDPPage, args: ToolArgs): Promise<string> {
  const target: string = args.target ?? '';
  const preUrl = getUrl(page);
  const coords = await findClickTarget(asVision(page), target);
  if (!coords) {
    for (const frame of (page.frames?.() ?? page.frames ?? [])) {
      try {
        await frame.evaluate(`(() => {
          var el = document.querySelector("div[role='button'], button, a");
          if (el) el.click();
        })()`);
        return 'clicked';
      } catch { /* skip */ }
    }
    return 'no-target-found';
  }
  await page.mouse.click(coords.x, coords.y);
  await new Promise(r => setTimeout(r, 1500));
  if (getUrl(page) !== preUrl) return 'clicked, page navigated';
  // JS text match click — match full target phrase first, then longest substrings
  const targetLow = target.toLowerCase();
  try {
    const ok = await page.evaluate(`(() => {
      var target = ${JSON.stringify(targetLow)};
      var els = document.querySelectorAll('button, a, [role="button"], input[type="submit"]');
      for (var i = 0; i < els.length; i++) {
        if (els[i].textContent.trim().toLowerCase().indexOf(target) >= 0) { els[i].click(); return true; }
      }
      return false;
    })()`);
    if (ok) { await new Promise(r => setTimeout(r, 1500)); return 'clicked via JS'; }
  } catch { /* skip */ }
  return 'clicked';
}

async function fill(page: CDPPage, args: ToolArgs): Promise<string> {
  const target: string = args.target ?? '';
  const value = resolveEnv(args.value ?? '');
  const coords = await findClickTarget(asVision(page), target);
  if (!coords) return 'no-field-found';
  await page.mouse.click(coords.x, coords.y);
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.type(value, { delay: 50 });
  return `filled ${value.length} chars`;
}

async function focus(page: CDPPage, args: ToolArgs): Promise<string> {
  const selector: string = args.selector ?? '';
  const simple = selector.split(' ').pop()?.toLowerCase().replace(/['"[\]]/g, '') ?? '';
  const candidates = [
    selector,
    `input[name="${selector}"]`,
    `input[type="${selector}"]`,
    `input[placeholder*="${selector}" i]`,
  ];
  if (simple && simple !== selector) {
    candidates.push(`input[name="${simple}"]`, `input[placeholder*="${simple}" i]`);
  }
  for (const sel of candidates) {
    try {
      const found = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(sel)});
        if (el) { el.focus(); el.click(); return true; }
        return false;
      })()`);
      if (found) return `focused: ${sel}`;
    } catch { /* skip */ }
  }
  return 'no-element-found';
}

async function typeText(page: CDPPage, args: ToolArgs): Promise<string> {
  const value = resolveEnv(args.value ?? '');
  await page.keyboard.press('Control+a');
  await new Promise(r => setTimeout(r, 100));
  await page.keyboard.type(value);
  return `typed ${value.length} chars`;
}

async function pressKey(page: CDPPage, args: ToolArgs): Promise<string> {
  const key: string = args.key ?? 'Enter';
  await page.keyboard.press(key);
  return `pressed ${key}`;
}

async function navigate(page: CDPPage, args: ToolArgs): Promise<string> {
  // Use main page for navigation (popup may be closed/crashed)
  let target = page;
  try {
    const pages = page.context?.().pages?.() ?? [];
    if (pages.length > 0) target = pages[0];
  } catch { /* skip */ }
  await target.goto(args.url ?? '', { waitUntil: 'domcontentloaded' });
  return `navigated to ${getUrl(target)}`;
}

async function scroll(page: CDPPage, args: ToolArgs): Promise<string> {
  const direction: string = args.direction ?? 'down';
  const amount = Number(args.amount ?? 400);
  const delta = direction === 'up' ? -amount : amount;
  await page.evaluate(`window.scrollBy(0, ${delta})`);
  return `scrolled ${direction} ${amount}`;
}

async function wait(page: CDPPage, args: ToolArgs): Promise<string> {
  const seconds = Number(args.seconds ?? 1);
  await new Promise(r => setTimeout(r, seconds * 1000));
  return `waited ${seconds}s`;
}

async function read(page: CDPPage, args: ToolArgs): Promise<string> {
  const question: string = args.question ?? '';
  const answer = await askPage(asVision(page), question);
  return `read: ${answer || 'NONE'}`;
}

async function solveCaptcha(page: CDPPage, args: ToolArgs): Promise<string> {
  const sitekey: string = args.sitekey ?? '';
  const action: string = args.action ?? 'register';
  const apiKey = process.env.ANTICAPTCHA_API_KEY ?? '';
  if (!apiKey || !sitekey) return 'error: no ANTICAPTCHA_API_KEY or sitekey';

  try {
    const task = {
      type: 'RecaptchaV3TaskProxyless',
      websiteURL: page.url,
      websiteKey: sitekey,
      isEnterprise: true,
      minScore: 0.7,
      pageAction: action,
    };
    const submitRes = await fetch('https://api.anti-captcha.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientKey: apiKey, task }),
    });
    const submitData = await submitRes.json() as any;
    if (submitData.errorId > 0) return `error: ${submitData.errorDescription}`;
    const taskId = submitData.taskId;

    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pollRes = await fetch('https://api.anti-captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientKey: apiKey, taskId }),
      });
      const pollData = await pollRes.json() as any;
      if (pollData.status === 'ready') {
        const token = pollData.solution.gRecaptchaResponse;
        await page.evaluate(`((t) => {
          if (window.grecaptcha && window.grecaptcha.enterprise)
            window.grecaptcha.enterprise.execute = () => Promise.resolve(t);
        })`, token);
        return `solved (${token.length} chars)`;
      }
      if (pollData.errorId > 0) return `error: ${pollData.errorDescription}`;
    }
    return 'error: captcha timed out';
  } catch (e: any) {
    return `error: ${e.message}`;
  }
}

async function checkEmail(page: CDPPage, args: ToolArgs): Promise<string> {
  const targetEmail = resolveEnv(args.email ?? '');
  const senderFilter: string = (args.sender ?? '').toLowerCase();
  const apiKey = process.env.RESEND_RECEIVING_API_KEY ?? '';
  if (!apiKey) return 'error: RESEND_RECEIVING_API_KEY not set';

  try {
    for (let attempt = 0; attempt < 30; attempt++) {
      const res = await fetch('https://api.resend.com/emails/receiving?limit=10', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      const data = await res.json() as any;
      for (const em of data.data ?? []) {
        const toAddrs: string[] = (em.to ?? []).map((t: any) =>
          typeof t === 'string' ? t : t.email ?? '');
        if (!toAddrs.some((a: string) => a.toLowerCase() === targetEmail.toLowerCase())) continue;
        if (senderFilter && !(em.from ?? '').toLowerCase().includes(senderFilter)) continue;
        const detailRes = await fetch(`https://api.resend.com/emails/receiving/${em.id}`, {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        const detail = await detailRes.json() as any;
        const body = `${detail.subject ?? ''} ${detail.text ?? ''} ${detail.html ?? ''}`;
        const codes = body.match(/\b\d{5,6}\b/g);
        if (codes) return `code: ${codes[0]}`;
      }
      await new Promise(r => setTimeout(r, 10000));
    }
    return 'no code received';
  } catch (e: any) {
    return `error: ${e.message}`;
  }
}

async function generateIdentity(page: CDPPage, args: ToolArgs): Promise<string> {
  const platform: string = args.platform ?? 'reddit';
  const adjectives = ['bright', 'swift', 'epic', 'cool', 'mega', 'ultra', 'hyper', 'super', 'clever', 'happy'];
  const nouns = ['wolf', 'eagle', 'shark', 'bear', 'dragon', 'phoenix', 'hawk', 'lion', 'fox', 'tiger'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 9000) + 100;
  const username = `${adj}${noun}${num}`;
  const domain = process.env.AGENT_DOMAIN ?? 'wisentmedia.com';
  const email = `${username}@${domain}`;
  const password = randomBytes(12).toString('base64url').slice(0, 16);
  const key = platform.toUpperCase();
  _envStore[`${key}_NEW_USERNAME`] = username;
  _envStore[`${key}_NEW_EMAIL`] = email;
  _envStore[`${key}_NEW_PASSWORD`] = password;
  return `generated: username=${username} email=${email} (use $${key}_NEW_PASSWORD for password)`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOLS: Record<string, ToolFn> = {
  click, fill, focus, type_text: typeText, press_key: pressKey,
  navigate, scroll, wait, read,
  solve_captcha: solveCaptcha, check_email: checkEmail,
  generate_identity: generateIdentity,
};

export async function dispatch(page: CDPPage, tool: string, args: ToolArgs): Promise<string> {
  const fn = TOOLS[tool];
  if (!fn) return `unknown tool: ${tool}`;
  return fn(page, args);
}

export { resolveEnv };
