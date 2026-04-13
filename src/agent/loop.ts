/**
 * Agent tool-use loop — the core control flow.
 * Screenshot → claude -p → parse JSON → dispatch tool → repeat.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
type CDPPage = any; // Works with both Playwright Page and CDPPage
import { dispatch } from './tools.js';

const MAX_ITERATIONS = 50;

export interface ToolCall {
  tool: string;
  args: Record<string, any>;
  thought?: string;
  result?: string;
  error?: string;
}

export interface LoopResult {
  value: any;
  history: ToolCall[];
}

export class AgentFailure extends Error {
  history: ToolCall[];
  constructor(reason: string, history: ToolCall[]) {
    super(reason);
    this.history = history;
  }
}

const SYSTEM_PROMPT = `You are a browser automation agent. Choose the single next action that makes progress toward the goal.

Tools:
  click(target)            Click an element described in plain English.
  fill(target, value)      Type value into an input described in plain English.
  focus(selector)          Focus an input by name/type/placeholder (for shadow DOM).
  type_text(value)         Type via keyboard after focusing. Use for signup forms.
  press_key(key)           Press a key (Enter, Tab, Escape).
  navigate(url)            Go to a URL.
  scroll(direction, amount) Scroll up/down by pixels.
  wait(seconds)            Pause.
  read(question)           Ask a question about the current page.
  solve_captcha(sitekey)   Solve reCAPTCHA on current page via API.
  check_email(email, sender) Poll for verification code sent to email.
  generate_identity(platform) Generate random username/email/password.
  done(value)              Terminal — you have the answer.
  give_up(reason)          Terminal — you cannot proceed.

Reply with ONLY a JSON object:
  {"thought": "...", "tool": "<tool_name>", "args": {...}}

Credentials: use $VAR placeholders in fill/type_text values (e.g. $REDDIT_NEW_EMAIL).
If a step fails, try something different. Do not repeat the same failing action.`;

function visionDir(): string {
  const dir = join(process.cwd(), 'recordings', 'vision');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function parseJsonFrom(raw: string): Record<string, any> {
  try { return JSON.parse(raw); } catch { /* continue */ }
  const matches = raw.matchAll(/\{/g);
  for (const m of matches) {
    try {
      const candidate = raw.slice(m.index!);
      const end = candidate.lastIndexOf('}');
      if (end === -1) continue;
      const parsed = JSON.parse(candidate.slice(0, end + 1));
      if ('tool' in parsed) return parsed;
    } catch { /* skip */ }
  }
  return { tool: 'give_up', args: { reason: `unparseable LLM output: ${raw.slice(0, 200)}` } };
}

function askLlm(goal: string, state: string, screenshotPath: string, step: number): Record<string, any> {
  const dir = visionDir();
  const imgBlock = screenshotPath ? `Read the current screenshot at ${screenshotPath}.\n\n` : '';
  const prompt = `${SYSTEM_PROMPT}\n\nGOAL: ${goal}\n\n${state}\n${imgBlock}Respond with ONLY the JSON object.`;

  let raw = '';
  try {
    const proc = spawnSync('claude', ['-p', '--output-format', 'json'], {
      input: prompt,
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    raw = (proc.stdout ?? '').trim();
    if (!raw && proc.stderr) {
      console.log(`[loop] claude stderr: ${proc.stderr.slice(0, 200)}`);
    }
    for (const line of raw.split('\n')) {
      if (line.includes('"type":"result"')) {
        try { raw = JSON.parse(line).result ?? raw; break; } catch { /* skip */ }
      }
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed.result) raw = parsed.result;
    } catch { /* not wrapped */ }
  } catch (e: any) {
    raw = `{"tool":"give_up","args":{"reason":"claude cli error: ${e.message?.slice(0, 100)}"}}`;
  }

  const logPath = join(dir, `loop_step${step}.json`);
  const decision = parseJsonFrom(raw);
  try { writeFileSync(logPath, JSON.stringify({ step, raw, parsed: decision }, null, 2)); } catch { /* skip */ }
  return decision;
}

function buildState(page: CDPPage, history: ToolCall[], envHints: Record<string, string>): string {
  const url = (typeof page.url === 'function' ? page.url() : page.url) ?? '';
  const recent = history.slice(-10);
  const hLines = recent.map((h, i) => {
    const offset = history.length - recent.length + i;
    return `  [${offset}] ${h.tool}(${JSON.stringify(h.args)}) -> ${h.error ?? h.result}`;
  }).join('\n') || '  (none)';
  const eLines = Object.entries(envHints).map(([k, v]) => `  ${k}=${v}`).join('\n') || '  (none)';
  return `CURRENT URL: ${url}\n\nACTION HISTORY:\n${hLines}\n\nAVAILABLE ENV VARS:\n${eLines}\n`;
}

export async function execute(
  page: CDPPage,
  goal: string,
  options?: { envHints?: Record<string, string>; replay?: ToolCall[] },
): Promise<LoopResult> {
  const history: ToolCall[] = [];
  const envHints = options?.envHints ?? {};
  let replay = options?.replay ?? null;

  const mainPage = page; // Store reference to original main page
  function getActivePage(p: any): any {
    try {
      const pages = p.context?.().pages?.() ?? [];
      // If current page is closed, return first open page
      if (p.isClosed?.()) return pages.find((pg: any) => !pg.isClosed?.()) ?? mainPage;
      // If we're on a popup (pages.length > 1) and it's not the main page, check if we should switch back
      if (pages.length === 1 && pages[0] !== p) return pages[0]; // Popup closed, back to main
    } catch { /* skip */ }
    return p;
  }

  for (let step = 0; step < MAX_ITERATIONS; step++) {
    page = getActivePage(page);
    let decision: Record<string, any>;

    if (replay && step < replay.length && !['read', 'done'].includes(replay[step].tool)) {
      decision = replay[step];
      console.log(`[loop] step ${step} REPLAY: ${decision.tool} ${JSON.stringify(decision.args)}`);
    } else {
      let screenshot: Buffer;
      try {
        screenshot = await page.screenshot({ scale: 'css' });
      } catch {
        page = getActivePage(page);
        screenshot = await page.screenshot({ scale: 'css' });
      }
      const imgPath = join(visionDir(), `loop_step${step}.png`);
      writeFileSync(imgPath, screenshot);
      const state = buildState(page, history, envHints);
      decision = askLlm(goal, state, imgPath, step);
    }

    const call: ToolCall = {
      tool: decision.tool ?? '',
      args: decision.args ?? {},
      thought: decision.thought ?? '',
    };
    console.log(`[loop] step ${step} thought: ${(call.thought ?? '').slice(0, 140)}`);
    console.log(`[loop] step ${step} tool: ${call.tool} args=${JSON.stringify(call.args)}`);

    if (call.tool === 'done') {
      call.result = 'done';
      history.push(call);
      return { value: call.args.value, history };
    }
    if (call.tool === 'give_up') {
      call.result = 'give_up';
      history.push(call);
      throw new AgentFailure(call.args.reason ?? 'unspecified', history);
    }

    try {
      call.result = await dispatch(page, call.tool, call.args);
      console.log(`[loop] step ${step} result: ${call.result?.slice(0, 100)}`);
    } catch (e: any) {
      call.error = String(e).slice(0, 500);
      console.log(`[loop] step ${step} error: ${call.error}`);
      if (call.error.toLowerCase().includes('closed')) {
        page = getActivePage(page);
        if (replay) { replay = null; console.log('[loop] replay aborted, switching to LLM'); }
      }
    }
    // Detect popup (Google SSO opens in new window)
    try {
      const pages = page.context?.().pages?.() ?? [];
      if (pages.length > 1 && pages[pages.length - 1] !== page) {
        page = pages[pages.length - 1];
        console.log(`[loop] popup detected: ${(typeof page.url === 'function' ? page.url() : page.url) ?? ''}`.slice(0, 120));
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch { /* skip */ }
    history.push(call);
  }

  throw new AgentFailure(`max iterations (${MAX_ITERATIONS}) exceeded`, history);
}

export { parseJsonFrom };
