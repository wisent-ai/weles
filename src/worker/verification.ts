import { callModelRouter, parseJsonFrom } from '../agent/loop.js';
import type { ActionLogRow } from './poll.js';

export type VerificationVerdict = 'pass' | 'fail' | 'uncertain';

export type RunVerification = {
  required: boolean;
  passed: boolean;
  verdict: VerificationVerdict;
  confidence: number;
  reason: string;
  evidence: string[];
  model?: string;
  router_url?: string;
  raw?: string;
};

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textParam(record: Record<string, unknown> | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function stringArray(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, limit);
}

function clampConfidence(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function normalizeVerdict(value: unknown): VerificationVerdict {
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  if (v === 'pass' || v === 'fail' || v === 'uncertain') return v;
  return 'uncertain';
}

export function shouldVerifyRun(row: ActionLogRow): boolean {
  if (process.env.WELES_VERIFY_RUNS === '0') return false;
  const params = objectOrEmpty(row.params);
  return params.verification_required === true
    || params.auto_promote_trajectory === true
    || params.build_test === true;
}

function verificationPrompt(row: ActionLogRow, result: Record<string, unknown>): string {
  const params = objectOrEmpty(row.params);
  const artifacts = objectOrEmpty(result.artifacts);
  const generic = objectOrEmpty(result.generic_browser_task);
  const yahoo = objectOrEmpty(result.yahoo_register);
  const pangram = objectOrEmpty(result.pangram);
  const service = objectOrEmpty(result.service_action);
  const objective = textParam(params, 'objective') ?? textParam(params, 'task') ?? textParam(params, 'prompt') ?? row.action;
  const url = textParam(params, 'url') ?? (typeof generic.final_url === 'string' ? generic.final_url : null) ?? '';
  const summary = {
    run_id: row.id,
    action: row.action,
    platform: row.platform ?? null,
    url,
    objective,
    constraints: objectOrEmpty(params.constraints),
    result: {
      generic_browser_task: generic,
      yahoo_register: yahoo,
      pangram,
      service_action: service,
      ban_signal: result.ban_signal ?? null,
      account_id: result.account_id ?? null,
    },
    artifacts: {
      screenshots: stringArray(artifacts.screenshots, 8),
      videos: stringArray(artifacts.videos, 4),
      video: typeof artifacts.video === 'string' ? artifacts.video : null,
      dom: stringArray(artifacts.dom, 4),
      logs: stringArray(artifacts.logs, 8),
    },
  };

  return `You are the Weles post-run verification gate. Decide whether the browser run actually satisfied its objective using the run result and artifact URLs. Prefer direct visual/browser evidence from screenshots, video, DOM, and logs. Do not pass a run only because the automation script exited successfully. If artifact access is unavailable or evidence is insufficient, use verdict "uncertain".

Return ONLY JSON with this exact shape:
{"verdict":"pass|fail|uncertain","confidence":0.0,"reason":"short reason","evidence":["specific evidence item"]}

Pass criteria:
- The final page/account/output satisfies the objective.
- No forbidden action or payment/subscription screen was completed.
- The run result and artifacts are consistent.

Run summary:
${JSON.stringify(summary, null, 2)}`;
}

export async function verifyRunArtifacts(row: ActionLogRow, result: Record<string, unknown>): Promise<RunVerification | null> {
  if (!shouldVerifyRun(row)) return null;
  try {
    const routed = await callModelRouter(verificationPrompt(row, result));
    const parsed = parseJsonFrom(routed.raw);
    const verdict = normalizeVerdict(parsed.verdict);
    const confidence = clampConfidence(parsed.confidence);
    const reason = typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim().slice(0, 500) : 'no verifier reason';
    const evidence = stringArray(parsed.evidence, 12);
    return {
      required: true,
      passed: verdict === 'pass' && confidence >= 0.6,
      verdict,
      confidence,
      reason,
      evidence,
      model: routed.model,
      router_url: routed.routerUrl,
      raw: routed.raw.slice(0, 2000),
    };
  } catch (e) {
    return {
      required: true,
      passed: false,
      verdict: 'uncertain',
      confidence: 0,
      reason: `verification model error: ${e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300)}`,
      evidence: [],
    };
  }
}
