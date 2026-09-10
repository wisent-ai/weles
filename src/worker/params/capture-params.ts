// Parameter contract for the two evidence-producing generic actions:
// generic_capture (landing-page stills/video) and generic_accessibility_audit
// (axe-core run against the same page lifecycle).
//
// The same parser runs twice on purpose: paramsToEnv calls it at dispatch, so a
// malformed row fails before a browser is launched, and the trajectory calls it
// again on the env payload it was handed, so a hand-run trajectory cannot skip
// the contract. Both call sites share this one implementation — the refusal
// sentences below are part of the action's contract and callers match on them.

export const CAPTURE_AXES = ['composition', 'interaction', 'reactivity', 'state-change', 'subpage'] as const;
export const CAPTURE_STEP_OPS = ['wait_selector', 'click', 'hover', 'focus', 'press', 'scroll', 'wait_ms', 'goto'] as const;
export const CAPTURE_ARTIFACT_ROOT = 'stado://weles-captures/';
export const CAPTURE_MAX_RECORD_SECONDS = Number('120');
export const CAPTURE_MAX_STEPS = Number('100');

export type CaptureAxis = (typeof CAPTURE_AXES)[number];
export type CaptureStepOp = (typeof CAPTURE_STEP_OPS)[number];

export interface CaptureStep {
  op: CaptureStepOp;
  value: string;
}

export interface CaptureViewport {
  width: number;
  height: number;
  device_scale_factor: number;
}

export interface CapturePlan {
  batch: string;
  site_slug: string;
  source_url: string;
  axis: CaptureAxis;
  viewport: CaptureViewport;
  full_page: boolean;
  steps: CaptureStep[];
  record_seconds: number;
  artifact_prefix: string;
}

export interface AccessibilityAuditPlan {
  batch: string;
  site_slug: string;
  source_url: string;
  viewport: CaptureViewport;
  artifact_prefix: string;
}

function record(value: unknown, action: string, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${action} requires ${name} as an object.`);
  }
  return value as Record<string, unknown>;
}

function slug(value: unknown, action: string, name: string): string {
  if (typeof value !== 'string' || !/^[a-z\d][a-z\d._-]{0,80}$/.test(value)) {
    throw new Error(`${action} requires ${name} as a lowercase slug of letters, digits, dot, dash or underscore.`);
  }
  return value;
}

function sourceUrl(value: unknown, action: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${action} requires source_url as an http(s) URL.`);
  }
  let parsed: URL;
  try { parsed = new URL(value); } catch { throw new Error(`${action} requires source_url as an http(s) URL.`); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${action} requires source_url as an http(s) URL.`);
  }
  return parsed.toString();
}

function integer(value: unknown, action: string, name: string, min: number, max: number): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${action} rejects ${name} ${JSON.stringify(value ?? null)}: ${name} must be an integer between ${min} and ${max}.`);
  }
  return parsed;
}

function viewport(value: unknown, action: string): CaptureViewport {
  const raw = record(value, action, 'viewport');
  const scaleRaw = raw.device_scale_factor ?? 1;
  const scale = typeof scaleRaw === 'string' ? Number(scaleRaw) : scaleRaw;
  if (typeof scale !== 'number' || !Number.isFinite(scale) || scale < 0.5 || scale > 4) {
    throw new Error(`${action} rejects viewport.device_scale_factor ${JSON.stringify(scaleRaw ?? null)}: device_scale_factor must be a number between 0.5 and 4.`);
  }
  return {
    width: integer(raw.width, action, 'viewport.width', Number('200'), Number('5000')),
    height: integer(raw.height, action, 'viewport.height', Number('200'), Number('20000')),
    device_scale_factor: scale,
  };
}

function artifactPrefix(value: unknown, action: string): string {
  if (typeof value !== 'string' || !value.startsWith(CAPTURE_ARTIFACT_ROOT) || value.length === CAPTURE_ARTIFACT_ROOT.length) {
    throw new Error(`${action} rejects artifact_prefix ${JSON.stringify(value ?? null)}: artifact_prefix must start with ${CAPTURE_ARTIFACT_ROOT} and name a path under it.`);
  }
  if (!value.endsWith('/')) {
    throw new Error(`${action} rejects artifact_prefix ${JSON.stringify(value)}: artifact_prefix must end with a slash.`);
  }
  const key = value.slice(CAPTURE_ARTIFACT_ROOT.length);
  const segments = key.slice(Number(false), key.length - Number('1')).split('/');
  if (segments.some((segment) => !/^[A-Za-z\d._-]+$/.test(segment) || segment === '.' || segment === '..')) {
    throw new Error(`${action} rejects artifact_prefix ${JSON.stringify(value)}: every path segment must be letters, digits, dot, dash or underscore.`);
  }
  return value;
}

function steps(value: unknown, action: string): CaptureStep[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${action} requires steps as an array.`);
  if (value.length > CAPTURE_MAX_STEPS) {
    throw new Error(`${action} rejects ${value.length} steps: steps must hold at most ${CAPTURE_MAX_STEPS} entries.`);
  }
  return value.map((entry) => {
    const raw = record(entry, action, 'each steps entry');
    const op = raw.op;
    if (typeof op !== 'string' || !(CAPTURE_STEP_OPS as readonly string[]).includes(op)) {
      throw new Error(`${action} rejects step op ${JSON.stringify(op ?? null)}: op must be one of ${CAPTURE_STEP_OPS.join(', ')}.`);
    }
    const stepValue = raw.value === undefined || raw.value === null ? '' : String(raw.value);
    if ((op === 'wait_selector' || op === 'click' || op === 'hover' || op === 'focus' || op === 'press' || op === 'goto') && !stepValue.trim()) {
      throw new Error(`${action} rejects step op ${JSON.stringify(op)} without a value: ${op} requires a value.`);
    }
    if (op === 'goto') sourceUrl(stepValue, action);
    if ((op === 'wait_ms' || op === 'scroll') && stepValue.trim()) {
      integer(stepValue, action, `step ${op} value`, op === 'scroll' ? Number('-100000') : Number(false), Number('100000'));
    }
    return { op: op as CaptureStepOp, value: stepValue };
  });
}

export function parseCaptureParams(params: Record<string, unknown>): CapturePlan {
  const action = 'generic_capture';
  const axis = params.axis;
  if (typeof axis !== 'string' || !(CAPTURE_AXES as readonly string[]).includes(axis)) {
    throw new Error(`${action} rejects axis ${JSON.stringify(axis ?? null)}: axis must be one of ${CAPTURE_AXES.join(', ')}.`);
  }
  const recordSecondsRaw = params.record_seconds ?? 0;
  const recordSeconds = typeof recordSecondsRaw === 'string' ? Number(recordSecondsRaw) : recordSecondsRaw;
  if (typeof recordSeconds !== 'number' || !Number.isFinite(recordSeconds) || recordSeconds < 0 || recordSeconds > CAPTURE_MAX_RECORD_SECONDS) {
    throw new Error(`${action} rejects record_seconds ${JSON.stringify(recordSecondsRaw ?? null)}: record_seconds must be between 0 and ${CAPTURE_MAX_RECORD_SECONDS}.`);
  }
  if (params.full_page !== undefined && typeof params.full_page !== 'boolean') {
    throw new Error(`${action} rejects full_page ${JSON.stringify(params.full_page)}: full_page must be true or false.`);
  }
  return {
    batch: slug(params.batch, action, 'batch'),
    site_slug: slug(params.site_slug, action, 'site_slug'),
    source_url: sourceUrl(params.source_url, action),
    axis: axis as CaptureAxis,
    viewport: viewport(params.viewport, action),
    full_page: params.full_page === true,
    steps: steps(params.steps, action),
    record_seconds: recordSeconds,
    artifact_prefix: artifactPrefix(params.artifact_prefix, action),
  };
}

export function parseAccessibilityAuditParams(params: Record<string, unknown>): AccessibilityAuditPlan {
  const action = 'generic_accessibility_audit';
  return {
    batch: slug(params.batch, action, 'batch'),
    site_slug: slug(params.site_slug, action, 'site_slug'),
    source_url: sourceUrl(params.source_url, action),
    viewport: viewport(params.viewport, action),
    artifact_prefix: artifactPrefix(params.artifact_prefix, action),
  };
}
