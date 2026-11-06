import { callJeden } from '../agent/loop.js';
import type { FunctionTool } from '../agent/model/router-call.js';

export type WelesTrajectoryWriterInput = {
  objective: string;
};

/**
 * The guidance a draft-first run hands its agent. `model-router` is the
 * writer's draft; `disabled` is a run started with
 * WELES_DISABLE_TRAJECTORY_WRITER=1, which carries no draft at all.
 */
export type WelesTrajectoryDraft = {
  source: 'model-router' | 'disabled';
  guidance: string;
  steps: string[];
  model?: string;
  routerUrl?: string;
  raw?: string;
};

/** The draft's fields: short imperative steps, and risk or extraction notes. */
const draftFields = {
  steps: { type: 'array', items: { type: 'string' } },
  notes: { type: 'array', items: { type: 'string' } },
};

/** The one function the writer answers through: its arguments are the draft. */
const draftTool: FunctionTool = {
  type: 'function',
  function: {
    name: 'write_trajectory',
    description:
      'The trajectory draft: short imperative steps, and optional risk or extraction notes.',
    parameters: {
      type: 'object',
      properties: draftFields,
      required: Object.keys(draftFields),
      additionalProperties: false,
    },
  },
};

function writerPrompt(input: WelesTrajectoryWriterInput): string {
  return [
    'You write Weles browser trajectories for the generic browser agent.',
    'Answer through write_trajectory: steps are short imperative steps, notes are optional risk or extraction notes.',
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

/**
 * The strings of a draft field, trimmed. An entry that is not a string, or
 * is blank, is refused naming the field and its position, with the whole
 * answer: the schema asked for strings, so anything else is the writer's
 * failure, not a step to drop.
 */
function draftStrings(
  answer: Record<string, unknown>,
  field: string,
  raw: string,
): string[] {
  const value = answer[field];
  if (!Array.isArray(value)) {
    throw new Error(`the trajectory writer's ${field} is not a list: ${raw}`);
  }
  return value.map((item, position) => {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(
        `the trajectory writer's ${field} entry ${position} is not a nonblank string: ${raw}`,
      );
    }
    return item.trim();
  });
}

/**
 * The writer's draft for a draft-first run, as one required write_trajectory
 * call. A writer that cannot be reached, or answers anything but that call
 * with at least one step, fails the run with its cause: no generic draft is
 * put in its place.
 */
export async function writeWelesTrajectoryDraft(
  input: WelesTrajectoryWriterInput,
): Promise<WelesTrajectoryDraft> {
  if (process.env.WELES_DISABLE_TRAJECTORY_WRITER === '1') {
    return {
      source: 'disabled',
      steps: [],
      guidance:
        'No trajectory draft: WELES_DISABLE_TRAJECTORY_WRITER is set, so the objective and constraints alone guide this run.',
    };
  }
  const routed = await callJeden(writerPrompt(input), { tools: [draftTool] });
  let answer: unknown;
  try {
    answer = JSON.parse(routed.raw);
  } catch (cause) {
    throw new Error(
      `the trajectory writer's write_trajectory arguments are not JSON (${cause instanceof Error ? cause.message : String(cause)}): ${routed.raw}`,
    );
  }
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new Error(
      `the trajectory writer's write_trajectory arguments are not an object: ${routed.raw}`,
    );
  }
  const fields = answer as Record<string, unknown>;
  const steps = [
    ...draftStrings(fields, 'steps', routed.raw),
    ...draftStrings(fields, 'notes', routed.raw).map((note) => `Note: ${note}`),
  ];
  if (!steps.length) {
    throw new Error(`the trajectory writer answered no step: ${routed.raw}`);
  }
  const header = `Brama trajectory draft${routed.model ? ` (${routed.model})` : ''}:`;
  return {
    source: 'model-router',
    model: routed.model,
    routerUrl: routed.routerUrl,
    raw: routed.raw,
    steps,
    guidance: [
      header,
      ...steps.map((step, index) => `${index + 1}. ${step}`),
    ].join('\n'),
  };
}
