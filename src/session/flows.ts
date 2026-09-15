/**
 * Flow cache — record successful tool call sequences, replay them later.
 * First run: LLM agent discovers flow → save to ~/.weles/flows/{name}.json
 * Next runs: replay saved flow without LLM → fast
 * If replay fails: return step index for agent takeover
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const FLOW_SCHEMA = 'weles.successful-flow.v1';

export interface FlowStep {
  tool: string;
  args: Record<string, unknown>;
  result?: string;
}

export interface Flow {
  name: string;
  steps: FlowStep[];
  lastSuccess: string;
}

const FLOWS_DIR = join(process.env.WELES_CACHE_DIR ?? join(homedir(), '.weles'), 'flows');

function flowPath(name: string): string {
  mkdirSync(FLOWS_DIR, { recursive: true });
  return join(FLOWS_DIR, `${name}.json`);
}

function isFlow(value: unknown): value is Flow {
  return typeof value === 'object' && value !== null
    && 'schema' in value && value.schema === FLOW_SCHEMA
    && 'name' in value && typeof value.name === 'string'
    && 'lastSuccess' in value && typeof value.lastSuccess === 'string'
    && 'steps' in value && Array.isArray(value.steps)
    && value.steps.every((step: unknown) => typeof step === 'object' && step !== null
      && 'tool' in step && typeof step.tool === 'string'
      && 'args' in step && typeof step.args === 'object' && step.args !== null
      && !Array.isArray(step.args)
      && (!('result' in step) || typeof step.result === 'string'));
}

export function loadFlow(name: string): Flow | null {
  const p = flowPath(name);
  if (!existsSync(p)) return null;
  try {
    const flow: unknown = JSON.parse(readFileSync(p, 'utf-8'));
    return isFlow(flow) ? flow : null;
  } catch { return null; }
}

export function saveFlow(name: string, steps: FlowStep[]): void {
  const flow = { schema: FLOW_SCHEMA, name, steps, lastSuccess: new Date().toISOString() };
  writeFileSync(flowPath(name), JSON.stringify(flow, null, 2));
}

/**
 * Replay a saved flow by calling dispatch for each step.
 * Returns { success: true } or { success: false, failedAtStep: N }
 * so the caller can hand off to the LLM agent from that point.
 */
export async function replayFlow(
  flow: Flow,
  dispatch: (tool: string, args: Record<string, unknown>) => Promise<string>,
): Promise<{ success: true; value?: unknown } | { success: false; failedAtStep: number; error?: unknown }> {
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    if (step.tool === 'done') return { success: true, value: step.args.value };
    if (step.tool === 'give_up') return { success: false, failedAtStep: i };
    try {
      await dispatch(step.tool, step.args);
    } catch (error) {
      return { success: false, failedAtStep: i, error };
    }
  }
  return { success: false, failedAtStep: flow.steps.length };
}
