/**
 * Agent tool-use loop — the core control flow.
 * Browser state -> Jeden -> Brama -> parse JSON -> dispatch tool -> repeat.
 *
 * What the model is shown and how its answer is read live in
 * `loop/observe.ts`; this file owns the step loop, the flow replay and the
 * dispatch.
 */

import type { WSession } from '../session/wsession.js';
import { dispatch } from './tools.js';
import { Capture } from '../capture/capture.js';
import { loadFlow, saveFlow, replayFlow } from '../session/flows.js';
import { humanIdlePause } from '../human/mouse.js';
import { callJeden } from './jeden.js';
import { askLlm, buildState, parseJsonFrom, type ModelDecisionProvider } from './loop/observe.js';
import { PageQuestionError } from '../vision/analyze.js';
import { CapabilityDeniedError, CapabilityTransportError } from '../utils/capability/broker.js';
import { CredentialFillError } from '../session/wsession-helpers/close/credential_fill.js';

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

export async function execute(
  session: WSession,
  goal: string,
  options?: { envHints?: Record<string, string>; replay?: ToolCall[]; flowName?: string; replayOnly?: boolean; skipSavedFlowReplay?: boolean; disableFlowPersistence?: boolean; disableArtifacts?: boolean; modelDecision?: ModelDecisionProvider; maxSteps?: number },
): Promise<LoopResult> {
  const history: ToolCall[] = [];
  const envHints = options?.envHints ?? {};
  let replay = options?.replay ?? null;
  const page = session.page;
  const capture = new Capture({ newPage: async () => page } as any);
  const flowName = options?.flowName;
  const maxSteps = options?.maxSteps ?? 40;


  // Try replaying a saved flow before using the LLM unless this is an explicit
  // keeper/discovery run. Keeper-first runs must map the live success path, not
  // silently reuse a stale local cache entry under the same flow name.
  if (flowName && !replay && !options?.skipSavedFlowReplay && !options?.disableFlowPersistence) {
    const saved = loadFlow(flowName);
    if (saved) {
      console.log(`[loop] Replaying saved flow: ${flowName} (${saved.steps.length} steps)`);
      const result = await replayFlow(saved, (tool, args) => dispatch(session, tool, args));
      if (result.success) {
        const v = typeof result.value === 'string' ? session.resolveEnv(result.value) : result.value;
        return { value: v, history: saved.steps as any };
      }
      if (result.error instanceof PageQuestionError || result.error instanceof CapabilityTransportError
        || result.error instanceof CapabilityDeniedError || result.error instanceof CredentialFillError) {
        const failed = saved.steps[result.failedAtStep];
        throw new AgentFailure(String(result.error), [{
          tool: failed.tool, args: failed.args, error: String(result.error),
        }]);
      }
      console.log(`[loop] Replay failed at step ${result.failedAtStep}, switching to LLM`);
    }
  }

  const mainPage = page;
  const knownPages = new Set(mainPage.context().pages());
  function getActivePage(current: any): any {
    const pages = mainPage.context().pages();
    let opened: any;
    for (const candidate of pages) {
      if (!knownPages.has(candidate) && !candidate.isClosed()) opened = candidate;
      knownPages.add(candidate);
    }
    if (opened) return opened;
    if (!current.isClosed()) return current;
    const surviving = pages.find((candidate: any) => !candidate.isClosed());
    if (surviving) return surviving;
    throw new AgentFailure('all browser session pages are closed', history);
  }

  let activePage = page;
  for (let step = 0; step < maxSteps; step++) {
    activePage = getActivePage(activePage);
    // Observations and dispatched actions must use the same popup or surviving tab.
    session.page = activePage;
    const observedUrl = activePage.url();
    let decision: Record<string, any>;

    if (replay && step < replay.length && (options?.replayOnly || !['read', 'done'].includes(replay[step].tool))) {
      decision = replay[step];
      console.log(`[loop] step ${step} REPLAY: ${decision.tool} ${JSON.stringify(decision.args)}`);
    } else if (replay && options?.replayOnly && step >= replay.length) {
      throw new AgentFailure('replay completed without done', history);
    } else {
      const imgPath = options?.disableArtifacts
        ? null
        : await capture.screenshot(activePage, `loop_step${step}`).catch(() => null);
      const state = await buildState(activePage, history, envHints);
      decision = await askLlm(
        goal,
        state,
        imgPath,
        step,
        session.label,
        options?.modelDecision,
        options?.disableArtifacts,
      );
    }

    const dispatchPage = getActivePage(activePage);
    if (dispatchPage !== activePage || activePage.url() !== observedUrl) {
      activePage = dispatchPage;
      session.page = activePage;
      console.log('[loop] page changed while choosing a tool; observing the current page before input');
      continue;
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
      if (flowName && !options?.disableFlowPersistence) {
        const steps = history.filter(h => !h.error).map(h => ({ tool: h.tool, args: h.args, result: h.result }));
        if (saveFlow(flowName, steps)) console.log(`[loop] Flow saved: ${flowName} (${steps.length} steps)`);
        else console.log(`[loop] Flow not cached: ${flowName} uses a one-shot credential capability`);
      }
      const resolved = typeof call.args.value === 'string' ? session.resolveEnv(call.args.value) : call.args.value;
      return { value: resolved, history };
    }
    if (call.tool === 'give_up') {
      call.result = 'give_up';
      history.push(call);
      throw new AgentFailure(call.args.reason ?? 'unspecified', history);
    }

    try {
      call.result = await dispatch(session, call.tool, call.args);
      console.log(`[loop] step ${step} result: ${call.result?.slice(0, 100)}`);
    } catch (e: any) {
      call.error = String(e).slice(0, 500);
      console.log(`[loop] step ${step} error: ${call.error}`);
      history.push(call);
      if (e instanceof PageQuestionError || e instanceof CapabilityTransportError
        || e instanceof CapabilityDeniedError || e instanceof CredentialFillError) {
        throw new AgentFailure(String(e), history);
      }
      if (replay && options?.replayOnly) {
        throw new AgentFailure(`replay failed at step ${step}: ${call.error}`, history);
      }
      if (call.error.toLowerCase().includes('closed')) {
        activePage = getActivePage(activePage);
        if (replay) { replay = null; console.log('[loop] replay aborted, switching to LLM'); }
      }
      continue;
    }
    history.push(call);
    const afterAction = getActivePage(activePage);
    if (afterAction !== activePage) {
      activePage = afterAction;
      console.log(`[loop] popup detected: ${activePage.url()}`.slice(0, 120));
      await humanIdlePause('deliberate');
    }
  }

  throw new AgentFailure(`browser agent exceeded ${maxSteps} steps`, history);
}

export { callJeden, parseJsonFrom };
