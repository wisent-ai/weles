/**
 * Agent tool-use loop — the core control flow.
 * Browser state -> Jeden -> Brama -> parse JSON -> dispatch tool -> repeat.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WSession } from '../session/wsession.js';
import { runRecordingsDir } from '../session/run-recordings.js';
import { dispatch } from './tools.js';
import { Capture } from '../capture/capture.js';
import { loadFlow, saveFlow, replayFlow, type FlowStep } from '../session/flows.js';
import { humanIdlePause } from '../human/mouse.js';

const DEFAULT_BRAMA_URL = 'https://model-router-1080673333190.us-central1.run.app';
const DEFAULT_AGENT_MODEL = 'claude-code-subscription';
const ROUTER_CONFIG_ROW = 'claude-reauth-config';

type ModelRouterConfig = {
  routerUrl: string;
  agentId: string;
  hmacSecret: string;
  model: string;
};

let modelRouterConfig: Promise<ModelRouterConfig> | null = null;

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
  fill(target, value)      Type a literal non-credential value into an input. Environment placeholders are forbidden.
  fill_credential(target, field_class, capability) Fill a password/email/username/token/api-key using an opaque typed Weles capability reference. Never request or provide plaintext.
  store_credential(target, field_class) Read a newly issued token/api-key from the named page element and write it directly to the task-authorized Skarbiec item. The value never enters tool arguments or results.
  focus(selector)          Focus an input by name/type/placeholder (for shadow DOM).
  type_text(value)         Type literal non-credential text after focusing. Environment placeholders are forbidden.
  press_key(key)           Press a key (Enter, Tab, Escape).
  navigate(url)            Go to a URL.
  scroll(direction, amount) Scroll up/down by pixels.
  wait(seconds)            Pause.
  read(question)           Ask a question about the current page.
  select_option(target, value) Select dropdown option. Use for date pickers.
  set_control(selector, value?, checked?) Set and verify an input/select/textarea by CSS selector in the main page or any iframe; dispatches input/change and reports resulting state plus visible validation text. Use when fill/click/select_option cannot make a form control stick.
  js_click(selector, text)   LAST RESORT click via selector or text. Prefer click(target) — js_click historically used a JS-evaluated el.click() which produces isTrusted=false events that bot classifiers (PerimeterX/Arkose/TikTok) reject. Use only when click(target), set_control(), and focus()+press_key() can't reach the element (Reddit shadow-DOM vote buttons being the canonical case).
  solve_captcha(sitekey)   Solve CAPTCHA/reCAPTCHA/Turnstile on current page via configured providers.
  check_email(email, sender) Poll for verification code sent to email.
  generate_identity(platform) Generate random identity: username/email/password/firstName/lastName/DOB.
  save_account(platform, username, email, password, name) Save account to database after registration.
  done(value)              Terminal — you have the answer.
  give_up(reason)          Terminal — you cannot proceed.

Reply with ONLY a JSON object:
  {"thought": "...", "tool": "<tool_name>", "args": {...}}

Credentials: use only fill_credential with an opaque capability reference whose target is weles; never place secrets or $ENV_VAR placeholders in fill/type_text. For task-authorized credential acquisition, use store_credential on the newly issued page element and never read or return its value.
If a step fails, try something different. Do not repeat the same failing action.`;

function visionDir(label?: string): string {
  const dir = runRecordingsDir(...(label ? [label, 'vision'] : ['vision'])); // G17: recordings/<run_uuid>/...
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

function nonEmpty(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

async function loadRouterConfigFromSupabase(): Promise<Partial<ModelRouterConfig>> {
  const supabaseUrl = nonEmpty(process.env.SUPABASE_URL) ?? nonEmpty(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const supabaseKey = nonEmpty(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!supabaseUrl || !supabaseKey) return {};
  const res = await fetch(`${supabaseUrl.replace(/\/$/, '')}/rest/v1/service_credentials?id=eq.${ROUTER_CONFIG_ROW}&select=metadata`, {
    headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
  });
  if (!res.ok) throw new Error(`model-router config lookup failed: ${res.status} ${await res.text()}`);
  const rows = await res.json() as Array<{ metadata?: Record<string, unknown> | null }>;
  const metadata = rows[0]?.metadata ?? {};
  return {
    routerUrl: nonEmpty(metadata.BRAMA_URL) ?? undefined,
    agentId: nonEmpty(metadata.WISENT_APP_AGENT_ID) ?? undefined,
    hmacSecret: nonEmpty(metadata.WISENT_APP_AGENT_AUTH_SECRET) ?? undefined,
  };
}

async function loadModelRouterConfig(): Promise<ModelRouterConfig> {
  if (modelRouterConfig) return modelRouterConfig;
  modelRouterConfig = (async () => {
    const envRouterUrl = nonEmpty(process.env.BRAMA_URL);
    const envAgentId = nonEmpty(process.env.WISENT_APP_AGENT_ID);
    const envHmacSecret = nonEmpty(process.env.WISENT_APP_AGENT_AUTH_SECRET);
    const db = envHmacSecret ? {} : await loadRouterConfigFromSupabase();
    const routerUrl = (envRouterUrl ?? db.routerUrl ?? DEFAULT_BRAMA_URL).replace(/\/+$/, '');
    const agentId = envAgentId ?? db.agentId ?? 'wisent-app';
    const hmacSecret = envHmacSecret ?? db.hmacSecret;
    const model = nonEmpty(process.env.WELES_AGENT_MODEL) ?? nonEmpty(process.env.MODEL_ROUTER_MODEL) ?? DEFAULT_AGENT_MODEL;
    if (!hmacSecret) {
      throw new Error(`missing WISENT_APP_AGENT_AUTH_SECRET and ${ROUTER_CONFIG_ROW}.metadata.WISENT_APP_AGENT_AUTH_SECRET`);
    }
    return { routerUrl, agentId, hmacSecret, model };
  })();
  return modelRouterConfig;
}

function runJedenProcess(
  binary: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ stdout: string; stderr: string }> {
  const configuredTimeout = Number.parseInt(process.env.WELES_JEDEN_TIMEOUT_MS ?? '', 10);
  const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 300_000;
  return new Promise((resolve, reject) => {
    execFile(binary, args, {
      cwd: process.cwd(),
      env,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`Jeden failed: ${String(stderr || error.message).trim().slice(0, 500)}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function callJeden(prompt: string): Promise<{ raw: string; model: string; routerUrl: string }> {
  const cfg = await loadModelRouterConfig();
  const binary = nonEmpty(process.env.WELES_JEDEN_BIN) ?? 'jeden';
  const sessionRoot = nonEmpty(process.env.WELES_JEDEN_SESSION_ROOT)
    ?? join(runRecordingsDir('jeden'), 'sessions');
  mkdirSync(sessionRoot, { recursive: true });
  const { stdout } = await runJedenProcess(binary, [
    'run',
    prompt,
    '--json',
    '--model-only',
    '--model',
    cfg.model,
    '--max-steps',
    '1',
    '--cwd',
    process.cwd(),
  ], {
    ...process.env,
    BRAMA_URL: cfg.routerUrl,
    WISENT_APP_AGENT_ID: cfg.agentId,
    WISENT_APP_AGENT_AUTH_SECRET: cfg.hmacSecret,
    JEDEN_SESSION_ROOT: sessionRoot,
  });
  let envelope: { ok?: boolean; text?: unknown; originalError?: unknown };
  try {
    envelope = JSON.parse(stdout) as typeof envelope;
  } catch {
    throw new Error(`Jeden returned invalid JSON: ${stdout.trim().slice(0, 500)}`);
  }
  const raw = typeof envelope.text === 'string' ? envelope.text.trim() : '';
  if (envelope.ok !== true || !raw) {
    throw new Error(`Jeden returned no model output: ${JSON.stringify(envelope).slice(0, 500)}`);
  }
  return { raw, model: cfg.model, routerUrl: cfg.routerUrl };
}

type ModelDecisionProvider = (prompt: string) => Promise<{ raw: string; model: string; routerUrl: string }>;

async function askLlm(goal: string, state: string, screenshotPath: string, step: number, label?: string, modelDecision: ModelDecisionProvider = callJeden): Promise<Record<string, any>> {
  const dir = visionDir(label);
  const imgBlock = screenshotPath ? `The current screenshot is saved locally at ${screenshotPath}; use the page observation below if image access is unavailable.\n\n` : '';
  const prompt = `${SYSTEM_PROMPT}\n\nGOAL: ${goal}\n\n${state}\n${imgBlock}Respond with ONLY the JSON object.`;

  let raw = '';
  let routerMeta: Record<string, unknown> = {};
  let lastRouterError = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const routed = await modelDecision(prompt);
      raw = routed.raw;
      routerMeta = { model: routed.model, router_url: routed.routerUrl, attempt };
      break;
    } catch (e: any) {
      lastRouterError = String(e.message ?? e).slice(0, 300);
      routerMeta = { error: lastRouterError, attempt };
      if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 3000));
    }
  }
  if (!raw) raw = JSON.stringify({ tool: 'give_up', args: { reason: `Jeden/Brama error after retries: ${lastRouterError}` } });

  const logPath = join(dir, `loop_step${step}.json`);
  const decision = parseJsonFrom(raw);
  try { writeFileSync(logPath, JSON.stringify({ step, raw, parsed: decision, router: routerMeta }, null, 2)); } catch { /* skip */ }
  return decision;
}

async function pageObservation(page: any): Promise<string> {
  const summarizeControls = (controls: any[]): string => (controls ?? []).map((el: any, i: number) => {
    const bits = [el.tag, el.role && `role=${el.role}`, el.name && `name=${el.name}`, el.type && `type=${el.type}`, el.label && `label=${el.label}`, el.value_state && `value=${el.value_state}`, typeof el.checked === 'boolean' && `checked=${el.checked}`, el.href && `href=${el.href}`].filter(Boolean);
    return `  [${i}] ${bits.join(' ')}`;
  }).join('\n') || '  (none)';
  const readFrame = async (frame: any): Promise<{ title?: string; text?: string; controls?: any[]; error?: string }> => {
    try {
      return await frame.evaluate(() => {
        const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000);
        const controls = Array.from(document.querySelectorAll('input, textarea, select, button, a, [role="button"], [role="link"]'))
          .slice(0, 80)
          .map((el) => {
            const anyEl = el as HTMLElement & { value?: string; type?: string; name?: string; href?: string; checked?: boolean; selectedOptions?: HTMLCollectionOf<HTMLOptionElement> };
            const label = anyEl.getAttribute('aria-label') || anyEl.getAttribute('placeholder') || anyEl.innerText || anyEl.getAttribute('title') || '';
            const type = anyEl.type || '';
            const name = anyEl.name || '';
            const value = typeof anyEl.value === 'string' ? anyEl.value.replace(/\s+/g, ' ').trim() : '';
            const sensitive = /password|token|key|secret|email|captcha|cookie|authorization/i.test(`${type} ${name} ${label}`);
            const selected = anyEl.tagName.toLowerCase() === 'select' && anyEl.selectedOptions?.[0]?.text
              ? anyEl.selectedOptions[0].text.replace(/\s+/g, ' ').trim().slice(0, 80)
              : '';
            const value_state = !value ? '' : (sensitive ? `[set len=${value.length}]` : (selected || `[set len=${value.length}]`));
            return {
              tag: anyEl.tagName.toLowerCase(),
              role: anyEl.getAttribute('role') || '',
              name,
              type,
              label: label.replace(/\s+/g, ' ').trim().slice(0, 120),
              value_state,
              checked: typeof anyEl.checked === 'boolean' ? anyEl.checked : undefined,
              href: anyEl.href || '',
            };
          });
        return { title: document.title, text, controls };
      });
    } catch (e: any) {
      return { error: String(e.message ?? e).slice(0, 160) };
    }
  };
  try {
    const data = await readFrame(page.mainFrame?.() ?? page);
    const frameSummaries: string[] = [];
    const frames = (page.frames?.() ?? []).filter((frame: any) => frame !== page.mainFrame?.()).slice(0, 12);
    for (const frame of frames) {
      const frameData = await readFrame(frame);
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

async function buildState(page: any, history: ToolCall[], envHints: Record<string, string>): Promise<string> {
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

export async function execute(
  session: WSession,
  goal: string,
  options?: { envHints?: Record<string, string>; replay?: ToolCall[]; flowName?: string; replayOnly?: boolean; skipSavedFlowReplay?: boolean; modelDecision?: ModelDecisionProvider; maxSteps?: number },
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
  if (flowName && !replay && !options?.skipSavedFlowReplay) {
    const saved = loadFlow(flowName);
    if (saved) {
      console.log(`[loop] Replaying saved flow: ${flowName} (${saved.steps.length} steps)`);
      const result = await replayFlow(saved, (tool, args) => dispatch(session, tool, args));
      if (result.success) {
        const v = typeof result.value === 'string' ? session.resolveEnv(result.value) : result.value;
        return { value: v, history: saved.steps as any };
      }
      console.log(`[loop] Replay failed at step ${result.failedAtStep}, switching to LLM`);
    }
  }

  const mainPage = page; // Store reference to original main page
  function getActivePage(p: any): any {
    try {
      const pages = p.context?.().pages?.() ?? [];
      if (p.isClosed?.()) return pages.find((pg: any) => !pg.isClosed?.()) ?? mainPage;
      if (pages.length === 1 && pages[0] !== p) return pages[0];
    } catch { /* skip */ }
    return p;
  }

  let activePage = page;
  for (let step = 0; step < maxSteps; step++) {
    activePage = getActivePage(activePage);
    let decision: Record<string, any>;

    if (replay && step < replay.length && (options?.replayOnly || !['read', 'done'].includes(replay[step].tool))) {
      decision = replay[step];
      console.log(`[loop] step ${step} REPLAY: ${decision.tool} ${JSON.stringify(decision.args)}`);
    } else if (replay && options?.replayOnly && step >= replay.length) {
      throw new AgentFailure('replay completed without done', history);
    } else {
      let screenshot: Buffer;
      try {
        screenshot = await activePage.screenshot({ scale: 'css', animations: 'disabled' });
      } catch {
        activePage = getActivePage(activePage);
        try { await activePage.waitForLoadState?.('domcontentloaded'); } catch { /* skip */ }
        try { screenshot = await activePage.screenshot({ scale: 'css', animations: 'disabled' }); }
        catch { screenshot = Buffer.from(''); }
      }
      const imgPath = await capture.screenshot(activePage, `loop_step${step}`).catch(() => {
        const p = join(visionDir(session.label), `loop_step${step}.png`); writeFileSync(p, screenshot); return p;
      });
      const state = await buildState(activePage, history, envHints);
      decision = await askLlm(goal, state, imgPath, step, session.label, options?.modelDecision);
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
      if (flowName) {
        const steps = history.map(h => ({ tool: h.tool, args: h.args, result: h.result }));
        saveFlow(flowName, steps);
        console.log(`[loop] Flow saved: ${flowName} (${steps.length} steps)`);
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
      if (replay && options?.replayOnly) {
        throw new AgentFailure(`replay failed at step ${step}: ${call.error}`, history);
      }
      if (call.error.toLowerCase().includes('closed')) {
        activePage = getActivePage(activePage);
        if (replay) { replay = null; console.log('[loop] replay aborted, switching to LLM'); }
      }
      continue;
    }
    // Detect popup (Google SSO opens in new window)
    try {
      const pages = activePage.context?.().pages?.() ?? [];
      if (pages.length > 1 && pages[pages.length - 1] !== activePage) {
        activePage = pages[pages.length - 1];
        console.log(`[loop] popup detected: ${(typeof activePage.url === 'function' ? activePage.url() : activePage.url) ?? ''}`.slice(0, 120));
        await humanIdlePause('deliberate');
      }
    } catch { /* skip */ }
    history.push(call);
  }

  throw new AgentFailure(`browser agent exceeded ${maxSteps} steps`, history);
}

export { callJeden, parseJsonFrom };
