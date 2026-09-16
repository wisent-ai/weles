import { callJeden, parseJsonFrom } from '../agent/loop.js';

export type WelesTrajectoryWriterInput = {
  objective: string;
};

export type WelesTrajectoryDraft = {
  source: 'model-router' | 'fallback';
  guidance: string;
  steps: string[];
  model?: string;
  routerUrl?: string;
  raw?: string;
  error?: string;
};

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === 'string' ? item.trim() : '')
    .filter((item) => item.length > 0);
}

function fallbackSteps(): string[] {
  return [
    'Follow only the supplied objective and constraints; report the observed outcome, not a presumed success.',
    'For an existing-account sign-in, use only the supplied scoped credentials through fill_credential. Never invent credentials, change the selected account, or register a replacement.',
    'Use a Weles-generated identity and registration profile only when the objective authorizes registration and that identity is provided for this run.',
    'Use the actual observed field label as the credential target and preserve every field of the issued capability object.',
    'Stop at an unavailable credential, provider refusal, or approval requirement with its actual operation and visible state. Do not select a notification or approval method prohibited by the objective.',
    'Do not return raw API keys, tokens, passwords, or secrets. Store newly issued material only through an explicitly authorized store_credential operation.',
  ];
}

function formatGuidance(steps: string[], source: WelesTrajectoryDraft['source'], model?: string): string {
  const header = source === 'model-router'
    ? `Brama trajectory draft${model ? ` (${model})` : ''}:`
    : 'Fallback Weles trajectory draft:';
  return [header, ...steps.map((step, index) => `${index + 1}. ${step}`)].join('\n');
}

function writerPrompt(input: WelesTrajectoryWriterInput): string {
  return [
    'You write Weles browser trajectories for the generic browser agent.',
    'Return ONLY a JSON object with this shape:',
    '{"steps":["short imperative step", "..."], "notes":["optional risk or extraction note"]}',
    '',
    'Weles execution contract:',
    '- The downstream browser agent has tools: navigate, click, fill, fill_credential, store_credential, type_text, focus, press_key, scroll, wait, read, select_option, set_control, js_click, solve_captcha, check_email, generate_identity, save_account, done, give_up.',
    '- The trajectory must follow only the objective below.',
    '- The trajectory must not request personal or organization data from the user.',
    '- Existing-account sign-in must use only the supplied scoped credentials through fill_credential. Never invent credentials, switch the selected identity, or register a replacement account.',
    '- Registration and generated profile details are allowed only when the objective authorizes registration and the run provides a generated Weles identity. Email confirmation must use that same identity.',
    '- Preserve every restriction on submission, account changes, approval methods, notifications, and secret capture. Stop at a prohibited or unavailable prerequisite with the actual failed operation and observed state.',
    '- The terminal done(value) must report only what the browser actually verified for the objective. It must never include a raw API key, token, password, or secret.',
    '',
    `Objective: ${input.objective}`,
  ].join('\n');
}

export function fallbackWelesTrajectoryDraft(input: WelesTrajectoryWriterInput, error?: unknown): WelesTrajectoryDraft {
  void input;
  const steps = fallbackSteps();
  return {
    source: 'fallback',
    steps,
    guidance: formatGuidance(steps, 'fallback'),
    error: error instanceof Error ? error.message.slice(0, 300) : error ? String(error).slice(0, 300) : undefined,
  };
}

export async function writeWelesTrajectoryDraft(input: WelesTrajectoryWriterInput): Promise<WelesTrajectoryDraft> {
  if (process.env.WELES_DISABLE_TRAJECTORY_WRITER === '1') return fallbackWelesTrajectoryDraft(input);
  try {
    const routed = await callJeden(writerPrompt(input));
    const parsed = parseJsonFrom(routed.raw);
    const steps = [
      ...stringArray(parsed.steps),
      ...stringArray(parsed.notes).map((note) => `Note: ${note}`),
    ];
    const normalizedSteps = steps.length > 0 ? steps : fallbackSteps();
    return {
      source: 'model-router',
      model: routed.model,
      routerUrl: routed.routerUrl,
      raw: routed.raw.slice(0, 2000),
      steps: normalizedSteps,
      guidance: formatGuidance(normalizedSteps, 'model-router', routed.model),
    };
  } catch (error) {
    return fallbackWelesTrajectoryDraft(input, error);
  }
}
