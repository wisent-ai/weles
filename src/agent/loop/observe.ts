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
import { BROWSER_TOOLS } from '../tools.js';


const SYSTEM_PROMPT = `You are a browser automation agent. Choose the single next action that makes progress toward the goal.

Use exactly one of the provided browser functions. Put its named parameters directly in the function arguments; do not wrap them in another tool or args object.

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
  const imgBlock = screenshotPath ? `The worker retained the current screenshot at ${screenshotPath}. To inspect its pixels, call read with a question.\n\n` : '';
  const prompt = `${SYSTEM_PROMPT}\n\nGOAL: ${goal}\n\n${state}\n${imgBlock}Call the single next browser function.`;

  let raw = '';
  let functionName: string | undefined;
  let routerMeta: Record<string, unknown> = {};
  let lastRouterError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const routed = await modelDecision(prompt, { tools: BROWSER_TOOLS });
      raw = routed.raw;
      functionName = routed.functionName;
      routerMeta = { model: routed.model, router_url: routed.routerUrl, attempt, finish_reason: routed.finishReason, usage: routed.usage, function_name: routed.functionName };
      break;
    } catch (e: any) {
      lastRouterError = String(e.message ?? e).slice(0, 300);
      routerMeta = { error: lastRouterError, attempt };
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  let decision: Record<string, any>;
  try {
    if (!raw) throw new Error(`Jeden/Brama error after retries: ${lastRouterError}`);
    const definition = BROWSER_TOOLS.find(tool => tool.function.name === functionName)?.function;
    if (!definition) throw new Error(`undeclared browser function: ${functionName}`);
    const args = JSON.parse(raw);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error(`${functionName} arguments must be an object`);
    const properties = definition.parameters.properties as Record<string, unknown>;
    const unknown = Object.keys(args).filter(key => !Object.hasOwn(properties, key));
    const missing = (definition.parameters.required as string[]).filter(key => !Object.hasOwn(args, key));
    if (unknown.length || missing.length) throw new Error(`${functionName} argument names: unknown=[${unknown.join(', ')}], missing=[${missing.join(', ')}]`);
    decision = { tool: functionName, args };
  } catch (error) {
    decision = { tool: 'give_up', args: { reason: String(error) } };
  }
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
