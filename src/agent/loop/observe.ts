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
import {
  readFrameObservation,
  type FrameObservation,
} from '../../session/observation/controls.js';
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

export type ModelDecisionProvider = typeof callJeden;

export async function askLlm(
  goal: string,
  state: string,
  screenshotPath: string | null,
  step: number,
  label?: string,
  modelDecision: ModelDecisionProvider = callJeden,
  disableArtifacts = false,
): Promise<Record<string, any>> {
  const dir = disableArtifacts ? null : visionDir(label);
  const imgBlock = screenshotPath
    ? `The worker retained the current screenshot at ${screenshotPath}. To inspect its pixels, call read with a question.\n\n`
    : '';
  const prompt = `${SYSTEM_PROMPT}\n\nGOAL: ${goal}\n\n${state}\n${imgBlock}Call the single next browser function.`;

  let raw = '';
  let functionName: string | undefined;
  let routerMeta: Record<string, unknown> = {};
  let lastRouterError = '';
  // One call: Jeden already fails over between subscriptions and routes, and
  // its error is what this step reports.
  try {
    const routed = await modelDecision(prompt, { tools: BROWSER_TOOLS });
    raw = routed.raw;
    functionName = routed.functionName;
    routerMeta = {
      model: routed.model,
      router_url: routed.routerUrl,
      finish_reason: routed.finishReason,
      usage: routed.usage,
      function_name: routed.functionName,
    };
  } catch (e: unknown) {
    lastRouterError = e instanceof Error ? e.message : String(e);
    routerMeta = { error: lastRouterError };
  }
  let decision: Record<string, any>;
  try {
    if (!raw) throw new Error(`Jeden/Brama error: ${lastRouterError}`);
    const definition = BROWSER_TOOLS.find(
      (tool) => tool.function.name === functionName,
    )?.function;
    if (!definition)
      throw new Error(`undeclared browser function: ${functionName}`);
    const args = JSON.parse(raw);
    if (!args || typeof args !== 'object' || Array.isArray(args))
      throw new Error(`${functionName} arguments must be an object`);
    const properties = definition.parameters.properties as Record<
      string,
      unknown
    >;
    const unknown = Object.keys(args).filter(
      (key) => !Object.hasOwn(properties, key),
    );
    const missing = (definition.parameters.required as string[]).filter(
      (key) => !Object.hasOwn(args, key),
    );
    if (unknown.length || missing.length)
      throw new Error(
        `${functionName} argument names: unknown=[${unknown.join(', ')}], missing=[${missing.join(', ')}]`,
      );
    decision = { tool: functionName, args };
  } catch (error) {
    decision = { tool: 'give_up', args: { reason: String(error) } };
  }
  if (dir) {
    const logPath = join(dir, `loop_step${step}.json`);
    try {
      writeFileSync(
        logPath,
        JSON.stringify(
          { step, raw, parsed: decision, router: routerMeta },
          null,
          '  ',
        ),
      );
    } catch (error) {
      console.error(`[weles] the step record ${logPath} could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return decision;
}

/** What the model is shown when the page could not be observed, with the cause. */
function observationError(cause: unknown): string {
  return `PAGE OBSERVATION ERROR: ${cause instanceof Error ? cause.message : String(cause)}`;
}

async function pageObservation(page: any): Promise<string> {
  // A control list the frame did not report, or an empty one, reads (none).
  const summarizeControls = (controls: string[] | undefined): string =>
    controls?.length
      ? controls.map((control) => `  ${control}`).join('\n')
      : '  (none)';
  // Only the fields an observation reported are shown.
  const stated = (fields: Array<[string, string | undefined]>): string[] =>
    fields
      .filter(([, value]) => value !== undefined)
      .map(([label, value]) => `${label}: ${value}`);
  try {
    // A main frame that cannot be read ends the observation with its cause
    // (the catch below); a child frame that cannot be read is named in its
    // own summary and the rest are still shown.
    const data = await readFrameObservation(page.mainFrame?.() ?? page);
    const frameSummaries: string[] = [];
    // Every child frame: a control the task needs can sit in any of them, and
    // the twelve-frame cut once here hid the rest from the model. A page type
    // without frames (the CDP page) has no child frames to read.
    const frames =
      typeof page.frames === 'function'
        ? page.frames().filter((frame: any) => frame !== page.mainFrame?.())
        : [];
    for (const frame of frames) {
      let frameData: FrameObservation;
      try {
        frameData = await readFrameObservation(frame);
      } catch (error) {
        frameSummaries.push(
          `FRAME url=${frame.url()}\nERROR: ${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (!frameData.text && !frameData.controls?.length) continue;
      frameSummaries.push(
        [
          `FRAME name=${frame.name()} url=${frame.url()}`,
          ...stated([['TEXT', frameData.text]]),
          `CONTROLS:\n${summarizeControls(frameData.controls)}`,
        ].join('\n'),
      );
    }
    const observed = [
      ...stated([
        ['TITLE', data.title],
        ['VISIBLE TEXT', data.text],
      ]),
      `CONTROLS:\n${summarizeControls(data.controls)}`,
    ].join('\n');
    if (!frameSummaries.length) return observed;
    return `${observed}\n\nFRAMES:\n${frameSummaries.join('\n\n')}`;
  } catch (error) {
    return observationError(error);
  }
}

export async function buildState(
  page: any,
  history: ToolCall[],
  envHints: Record<string, string>,
): Promise<string> {
  const url = typeof page.url === 'function' ? page.url() : page.url;
  // The whole action history, numbered from the run's first action: the
  // model decides the next step knowing everything it already tried, not
  // only its last ten actions.
  const hLines = history.length
    ? history
        .map(
          (h, offset) =>
            `  [${offset}] ${h.tool}(${JSON.stringify(h.args)}) -> ${h.error ?? h.result}`,
        )
        .join('\n')
    : '  (none)';
  const envNames = Object.keys(envHints);
  const eLines = envNames.length
    ? envNames.map((key) => `  ${key}=[value unavailable to model]`).join('\n')
    : '  (none)';
  const observation = await pageObservation(page);
  return `CURRENT URL: ${url}\n\nPAGE OBSERVATION:\n${observation}\n\nACTION HISTORY:\n${hLines}\n\nAVAILABLE ENV VARS:\n${eLines}\n`;
}
