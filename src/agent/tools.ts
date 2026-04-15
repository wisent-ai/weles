/**
 * Agent tool dispatch — each tool takes a CDPPage + args, returns a result string.
 * Tools are general-purpose. The LLM decides the sequence. No page-specific logic.
 */

import { randomBytes } from 'node:crypto';
type CDPPage = any; // Works with both Playwright Page and CDPPage
import { findClickTarget, askPage, type ScreenshottablePage } from '../vision/analyze.js';
import { humanClick } from '../human/mouse.js';

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
  await humanClick(page, coords.x, coords.y);
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
  const kws = target.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  // Playwright locator.fill() — inputs, textareas, and contenteditable
  const tags = ['input', 'textarea', '[contenteditable]'];
  const sels = kws.flatMap(k => tags.flatMap(t => [`${t}[name*="${k}"]`, `${t}[placeholder*="${k}" i]`, `${t}[aria-label*="${k}" i]`]));
  for (const sel of sels) {
    try { const el = page.locator?.(sel)?.first?.(); if (el && await el.isVisible()) { await el.fill(value); return `filled ${value.length} chars`; } } catch { /* skip */ }
  }
  // Coordinate click on elements with matching placeholder (shadow DOM web components)
  const tgtJson = JSON.stringify(target.toLowerCase());
  const coords = await page.evaluate(`(()=>{var t=${tgtJson};var els=document.querySelectorAll('*');for(var i=0;i<els.length;i++){var r=els[i].getBoundingClientRect();var ph=(els[i].getAttribute('placeholder')||'').toLowerCase();if(r.width>50&&r.height>10&&r.x>0&&ph&&ph.indexOf(t)>=0)return{x:r.x+r.width/2,y:r.y+r.height/2}}return null})()`);
  if (coords) { await page.mouse.click(coords.x, coords.y); await new Promise(r => setTimeout(r, 500)); await page.keyboard.type(value, { delay: 30 }); return `filled ${value.length} chars`; }
  // Vision click + keyboard.type
  const vc = await findClickTarget(asVision(page), target);
  if (!vc) return 'no-field-found';
  await page.mouse.click(vc.x, vc.y);
  await new Promise(r => setTimeout(r, 300));
  await page.keyboard.press('Meta+a').catch(() => page.keyboard.press('Control+a').catch(() => {}));
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
  await page.keyboard.type(value, { delay: 30 });
  return `typed ${value.length} chars`;
}

async function pressKey(page: CDPPage, args: ToolArgs): Promise<string> {
  const key: string = args.key ?? 'Enter';
  await page.keyboard.press(key);
  return `pressed ${key}`;
}

async function navigate(page: CDPPage, args: ToolArgs): Promise<string> {
  await page.goto(args.url ?? '', { waitUntil: 'domcontentloaded' });
  return `navigated to ${getUrl(page)}`;
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
  const email = resolveEnv(args.email ?? '').toLowerCase();
  const sender = (args.sender ?? '').toLowerCase();
  const key = process.env.RESEND_RECEIVING_API_KEY ?? '';
  if (!key) return 'error: RESEND_RECEIVING_API_KEY not set';
  try {
    for (let i = 0; i < 30; i++) {
      const r = await fetch('https://api.resend.com/emails/receiving?limit=10', { headers: { Authorization: `Bearer ${key}` } });
      for (const em of ((await r.json()) as any).data ?? []) {
        const to = (em.to ?? []).map((t: any) => (typeof t === 'string' ? t : t.email ?? '').toLowerCase());
        if (!to.includes(email)) continue;
        if (sender && !(em.from ?? '').toLowerCase().includes(sender)) continue;
        const d = await (await fetch(`https://api.resend.com/emails/receiving/${em.id}`, { headers: { Authorization: `Bearer ${key}` } })).json() as any;
        const codes = `${d.subject ?? ''} ${d.text ?? ''} ${d.html ?? ''}`.match(/\b\d{5,6}\b/g);
        if (codes) return `code: ${codes[0]}`;
      }
      await new Promise(r => setTimeout(r, 10000));
    }
    return 'no code received';
  } catch (e: any) { return `error: ${e.message}`; }
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

async function selectOption(page: CDPPage, args: ToolArgs): Promise<string> {
  const target: string = args.target ?? '';
  const value: string = args.value ?? '';
  const valLow = JSON.stringify(value.toLowerCase());
  // Native <select>
  const native = await page.evaluate(`(() => { var v=${valLow};
    var selects = document.querySelectorAll('select');
    for (var i=0;i<selects.length;i++) { var s=selects[i];
      for (var j=0;j<s.options.length;j++) { if (s.options[j].text.toLowerCase().indexOf(v)>=0) { s.selectedIndex=j; s.dispatchEvent(new Event('change',{bubbles:true})); return s.options[j].text; }}}
    return null; })()`);
  if (native) return `selected: ${native}`;
  // Custom div dropdowns — find by label text matching target
  const tgtLow = JSON.stringify(target.toLowerCase());
  const opened = await page.evaluate(`(() => { var tgt=${tgtLow};
    var els=document.querySelectorAll('[class*="select"],[class*="Select"],[class*="dropdown"],[class*="Dropdown"]');
    for(var i=0;i<els.length;i++) { var t=els[i].textContent.trim().toLowerCase();
      if(t.indexOf(tgt)===0 || t===tgt) { els[i].click(); return true; }}
    return false; })()`);
  if (opened) {
    await new Promise(r => setTimeout(r, 500));
    const clicked = await page.evaluate(`(() => { var v=${valLow}; var items=document.querySelectorAll('[role="option"],[class*="option"],[class*="Option"],li');
      for(var i=0;i<items.length;i++) { var t=items[i].textContent.trim().toLowerCase();
        if(t===v && items[i].children.length===0) { items[i].click(); return items[i].textContent.trim(); }}
      for(var i=0;i<items.length;i++) { var t=items[i].textContent.trim().toLowerCase();
        if(t.indexOf(v)>=0 && items[i].children.length===0) { items[i].click(); return items[i].textContent.trim(); }}
      return null; })()`);
    if (clicked) return `selected: ${clicked}`;
  }
  return 'no-select-found';
}

async function jsClick(page: CDPPage, args: ToolArgs): Promise<string> {
  const sel = JSON.stringify(args.selector ?? ''), txt = JSON.stringify((args.text ?? '').toLowerCase());
  // 1. Shadow DOM deep search first (Reddit vote buttons have no text/aria)
  const sr = await page.evaluate(`(()=>{var t=${txt};function F(r){var a=[];r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot){var sr=e.shadowRoot;a=a.concat(Array.from(sr.querySelectorAll('[data-post-click-location] button')));a=a.concat(F(sr))}});return a}var bs=F(document);if(t&&t.indexOf('upvote')>=0&&bs.length>0){bs[0].click();return'clicked upvote (shadow)'}if(t&&t.indexOf('downvote')>=0&&bs.length>1){bs[1].click();return'clicked downvote (shadow)'}return null})()`);
  if (sr) return sr;
  // 2. Regular DOM: selector match, then text match
  const r = await page.evaluate(`(()=>{function F(r,s){var a=Array.from(r.querySelectorAll(s));r.querySelectorAll('*').forEach(function(e){if(e.shadowRoot)a=a.concat(F(e.shadowRoot,s))});return a}var s=${sel},t=${txt};if(s){try{var e=F(document,s)[0];if(e){e.click();return'clicked: '+s}}catch(e){}}if(t){var els=F(document,'button,a,[role="button"],[class*="vote"],[class*="like"],[class*="star"],[class*="follow"]');for(var i=0;i<els.length;i++){var x=((els[i].textContent||'')+(els[i].getAttribute('aria-label')||'')).toLowerCase();if(x.indexOf(t)>=0){els[i].click();return'clicked: '+(els[i].getAttribute('aria-label')||els[i].textContent||'').trim().slice(0,40)}}}return null})()`);
  if (r) return r;
  return 'no-element-found';
}

export const TOOLS: Record<string, ToolFn> = {
  click, fill, focus, type_text: typeText, press_key: pressKey,
  navigate, scroll, wait, read, select_option: selectOption,
  js_click: jsClick, solve_captcha: solveCaptcha,
  check_email: checkEmail, generate_identity: generateIdentity,
};

export async function dispatch(page: CDPPage, tool: string, args: ToolArgs): Promise<string> {
  const fn = TOOLS[tool];
  if (!fn) return `unknown tool: ${tool}`;
  return fn(page, args);
}

export { resolveEnv };
