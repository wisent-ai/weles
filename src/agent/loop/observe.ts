/**
 * What the loop shows the model and how it reads the answer: the system
 * prompt, the page observation, the state block, and the decision request
 * with its retries and its per-step record under the run's vision directory.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runRecordingsDir } from '../../session/run-recordings.js';
import { callJeden } from '../jeden.js';
import type { ToolCall } from '../loop.js';
import { readFrameObservation } from '../../session/observation/controls.js';

const BROWSER_ACTION = {
  name: 'browser_action',
  description: 'Choose the single next browser action from the available tools.',
  parameters: {
    type: 'object',
    properties: {
      thought: { type: 'string' },
      tool: { type: 'string' },
      args: { type: 'object', additionalProperties: true },
    },
    required: ['tool', 'args'],
    additionalProperties: false,
  },
};

const SYSTEM_PROMPT = `You are a browser automation agent. Choose the single next action that makes progress toward the goal.

Tools:
  click(target)            Prefer the complete current CONTROLS entry: preserve its tag and every reported field. Include [index] to distinguish identical controls. Otherwise describe the element in plain English.
  fill(target, value)      Type a literal non-credential value into an input. Environment placeholders are forbidden.
  fill_credential(target, field_class, capability) Fill a password/email/username/token/api-key using an opaque typed Weles capability reference. Never request or provide plaintext.
  fill_identity(target, field) Fill one field from the current run-generated identity without exposing it. Field: email, password, username, first_name, last_name, birth_month, birth_day, or birth_year.
  store_credential(target, field_class) Read a newly issued token/api-key from the named page element and write it directly to the task-authorized Skarbiec item. The value never enters tool arguments or results.
  focus(selector)          Focus an input by name/type/placeholder (for shadow DOM).
  type_text(value)         Type literal non-credential text after focusing. Environment placeholders are forbidden.
  press_key(key)           Press a key (Enter, Tab, Escape).
  navigate(url)            Go to a URL.
  scroll(direction, amount) Scroll up/down by pixels.
  wait(seconds)            Pause.
  read(question)           Read only the current screenshot. This cannot click, scroll, navigate, or change page state.
  select_option(target, value) Select dropdown option. Use for date pickers.
  set_control(selector, value?, checked?) Set and verify an input/select/textarea by CSS selector in the main page or any iframe; dispatches input/change and reports resulting state plus visible validation text. Use when fill/click/select_option cannot make a form control stick.
  js_click(selector, text)   LAST RESORT click via selector or text. Prefer click(target) — js_click historically used a JS-evaluated el.click() which produces isTrusted=false events that bot classifiers (PerimeterX/Arkose/TikTok) reject. Use only when click(target), set_control(), and focus()+press_key() can't reach the element (Reddit shadow-DOM vote buttons being the canonical case).
  solve_captcha(sitekey)   Solve a detected CAPTCHA, including Brave proof-of-work. It may click the site's verification control and wait for automatic submission. Returns solved, failed, or no supported captcha detected.
  check_email(email, sender) Poll for verification code sent to email.
  generate_identity(platform) Generate random identity: username/email/password/firstName/lastName/DOB.
  save_account(platform, username, email, password, name) Save account to database after registration.
  done(value)              Terminal — you have the answer.
  give_up(reason)          Terminal — you cannot proceed.

Return one browser_action function call with arguments shaped as:
  {"thought": "...", "tool": "<tool_name>", "args": {...}}

Credentials: use fill_identity only for the current run-generated identity; use fill_credential with an opaque capability reference whose target is weles for all externally supplied credentials. Never place secrets or $ENV_VAR placeholders in fill/type_text. For task-authorized credential acquisition, use store_credential on the newly issued page element and never read or return its value.
Only count an action as completed when ACTION HISTORY records its successful tool result. A question asking for an action does not execute it. If information is not visible, use the actual scroll or navigation tool before reading again. Call done only after each goal condition is confirmed by observed results and the current URL.
If a step fails, try something different. Do not repeat the same failing action.`;

function visionDir(label?: string): string {
  const dir = runRecordingsDir(...(label ? [label, 'vision'] : ['vision'])); // G17: recordings/<run_uuid>/...
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function parseJsonFrom(raw: string): Record<string, any> {
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

export type ModelDecisionProvider = typeof callJeden;

export async function askLlm(goal: string, state: string, screenshotPath: string | null, step: number, label?: string, modelDecision: ModelDecisionProvider = callJeden, disableArtifacts = false): Promise<Record<string, any>> {
  const dir = disableArtifacts ? null : visionDir(label);
  const imgBlock = screenshotPath ? `The current screenshot is saved locally at ${screenshotPath}; use the page observation below if image access is unavailable.\n\n` : '';
  const prompt = `${SYSTEM_PROMPT}\n\nGOAL: ${goal}\n\n${state}\n${imgBlock}Respond with one browser_action function call.`;

  let raw = '';
  let routerMeta: Record<string, unknown> = {};
  let lastRouterError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const routed = await modelDecision(prompt, { outputFunction: BROWSER_ACTION });
      raw = routed.raw;
      routerMeta = { model: routed.model, router_url: routed.routerUrl, attempt, finish_reason: routed.finishReason, usage: routed.usage, function_name: routed.functionName };
      break;
    } catch (e: any) {
      lastRouterError = String(e.message ?? e).slice(0, 300);
      routerMeta = { error: lastRouterError, attempt };
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  if (!raw) raw = JSON.stringify({ tool: 'give_up', args: { reason: `Jeden/Brama error after retries: ${lastRouterError}` } });

  const decision = parseJsonFrom(raw);
  if (dir) {
    const logPath = join(dir, `loop_step${step}.json`);
    try { writeFileSync(logPath, JSON.stringify({ step, raw, parsed: decision, router: routerMeta }, null, 2)); } catch { /* skip */ }
  }
  return decision;
}

async function pageObservation(page: any): Promise<string> {
  const summarizeControls = (controls: string[]): string => controls.length
    ? controls.map(control => `  ${control}`).join('\n')
    : '  (none)';
  try {
    const data = await readFrameObservation(page.mainFrame?.() ?? page);
    if (data.error) return `PAGE OBSERVATION ERROR: ${data.error}`;
    const frameSummaries: string[] = [];
    const frames = (page.frames?.() ?? []).filter((frame: any) => frame !== page.mainFrame?.()).slice(0, 12);
    for (const frame of frames) {
      const frameData = await readFrameObservation(frame);
      if (frameData.error) {
        frameSummaries.push(`FRAME url=${frame.url()}\nERROR: ${frameData.error}`);
        continue;
      }
      const controls = summarizeControls(frameData.controls ?? []);
      if (frameData.text || controls !== '  (none)') {
        frameSummaries.push(`FRAME name=${frame.name?.() ?? ''} url=${frame.url?.() ?? ''}\nTEXT: ${frameData.text ?? ''}\nCONTROLS:\n${controls}`);
      }
    }
    return `TITLE: ${data.title ?? ''}\nVISIBLE TEXT: ${data.text ?? ''}\nCONTROLS:\n${summarizeControls(data.controls ?? [])}${frameSummaries.length ? `\n\nFRAMES:\n${frameSummaries.join('\n\n')}` : ''}`;
  } catch (e: any) {
    return `PAGE OBSERVATION ERROR: ${String(e.message ?? e).slice(0, 300)}`;
  }
}

export async function buildState(page: any, history: ToolCall[], envHints: Record<string, string>): Promise<string> {
  const url = (typeof page.url === 'function' ? page.url() : page.url) ?? '';
  const recent = history.slice(-10);
  const hLines = recent.map((h, i) => {
    const offset = history.length - recent.length + i;
    return `  [${offset}] ${h.tool}(${JSON.stringify(h.args)}) -> ${h.error ?? h.result}`;
  }).join('\n') || '  (none)';
  const eLines = Object.keys(envHints).map((key) => `  ${key}=[value unavailable to model]`).join('\n') || '  (none)';
  const observation = await pageObservation(page);
  return `CURRENT URL: ${url}\n\nPAGE OBSERVATION:\n${observation}\n\nACTION HISTORY:\n${hLines}\n\nAVAILABLE ENV VARS:\n${eLines}\n`;
}
