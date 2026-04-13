/**
 * Agent tool dispatch — each tool takes a CDPPage + args, returns a result string.
 * Tools are general-purpose. The LLM decides the sequence. No page-specific logic.
 */

import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import type { CDPPage } from '../cdp/page/page.js';
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

async function click(page: CDPPage, args: ToolArgs): Promise<string> {
  const target: string = args.target ?? '';
  const preUrl = page.url;
  const coords = await findClickTarget(asVision(page), target);
  if (!coords) {
    // Vision couldn't find it — try iframes via JS
    for (const frame of page.frames) {
      if (frame === page.mainFrame) continue;
      try {
        await frame.evaluate(`(() => {
          const el = document.querySelector("div[role='button'], button, a");
          if (el) el.click();
        })()`);
        return 'clicked';
      } catch { /* skip */ }
    }
    return 'no-target-found';
  }
  await page.mouse.click(coords.x, coords.y);
  await new Promise(r => setTimeout(r, 1500));
  return page.url !== preUrl ? 'clicked, page navigated' : 'clicked';
}

async function fill(page: CDPPage, args: ToolArgs): Promise<string> {
  const target: string = args.target ?? '';
  const value = resolveEnv(args.value ?? '');
  const coords = await findClickTarget(asVision(page), target);
  if (!coords) return 'no-field-found';
  await page.mouse.click(coords.x, coords.y);
  await new Promise(r => setTimeout(r, 300));
  // Check if an input is focused — if not, find nearest input and focus it via JS
  const hasFocus = await page.evaluate(`(() => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
  })()`);
  if (!hasFocus) {
    // Try to find an input near the click target by text matching
    const words = target.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    await page.evaluate(`((words) => {
      const inputs = document.querySelectorAll('input, textarea');
      for (const inp of inputs) {
        const ctx = (inp.placeholder + ' ' + inp.name + ' ' + (inp.labels?.[0]?.textContent ?? '') + ' ' + (inp.getAttribute('aria-label') ?? '')).toLowerCase();
        if (words.some(w => ctx.includes(w))) { inp.focus(); inp.click(); return; }
      }
      if (inputs.length > 0) inputs[0].focus();
    })`, words);
    await new Promise(r => setTimeout(r, 200));
  }
  // Select all existing content then type new value
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.type(value);
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
  await page.goto(args.url ?? '', { waitUntil: 'domcontentloaded' });
  return `navigated to ${page.url}`;
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
