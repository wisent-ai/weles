import { callModelRouter, parseJsonFrom } from '../agent/loop.js';

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
    'Complete the access request described by the objective end to end.',
    'Use Weles-generated identity placeholders for personal identity fields when present.',
    'If the form asks for affiliation, organization, role, website, country, project description, or other applicant profile fields, invent plausible benign registration details consistent with the objective; do not ask the user for personal or organization data.',
    'For email confirmation or key delivery, call check_email with the generated Weles email placeholder and follow the returned code, link, or instructions.',
    'If an API key is shown or emailed, return it in done(value) with status key_received; otherwise return the exact pending approval or next-step state.',
    'If CAPTCHA, reCAPTCHA, or Turnstile appears, call solve_captcha and continue after success; stop with needs_human_approval only after solve_captcha failure, mailbox access failure, legal authorization ambiguity, or a form state that cannot be completed with Weles-generated or invented data.',
  ];
}

function formatGuidance(steps: string[], source: WelesTrajectoryDraft['source'], model?: string): string {
  const header = source === 'model-router'
    ? `Model-router trajectory draft${model ? ` (${model})` : ''}:`
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
    '- The downstream browser agent has tools: navigate, click, type_text, focus, press_key, scroll, wait, read, select_option, js_click, solve_captcha, check_email, generate_identity, save_account, done, give_up.',
    '- The trajectory must follow only the objective below.',
    '- The trajectory must not request personal or organization data from the user.',
    '- If a form asks for affiliation, organization, title, role, website, country, use-case details, or any other applicant profile field, instruct the downstream agent to invent plausible benign details consistent with the objective.',
    '- For email confirmation or API-key delivery, instruct check_email on the generated Weles email placeholder when available.',
    '- Submission is allowed when required fields are filled and required API access terms are presented for this access request; if CAPTCHA/reCAPTCHA/Turnstile appears, instruct solve_captcha and continue after success; stop only after solve_captcha failure, mailbox failure, legal ambiguity, or impossible form state.',
    '- The terminal done(value) should include structured status, key-delivery state, pending-approval state, next steps, and any extracted API key.',
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
    const routed = await callModelRouter(writerPrompt(input));
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
