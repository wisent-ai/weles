// weles-builder: instructions only. The body is the goal, as text, or as JSON
// {"instructions": "..."}; no url and no parameters. The agent starts on the
// neutral page the deployment declares in WELES_BUILDER_BOOTSTRAP_URL, drives
// itself to whatever site the task implies and, on success, its executed
// steps are saved as a new reusable trajectory (generic browser_task
// draft-first behavior).
import { constants as http } from 'node:http2';
import { ALLOW_RAW_CREDS, ALLOW_UNAUTH, TOKEN } from '../../configuration.mjs';
import { authorized, json, readText } from '../../http-exchange.mjs';
import { RouteRefusal, answerRefusal } from './refusal.mjs';

// Prepended to the caller's instructions so the agent self-navigates: the
// caller supplies no url, only the goal.
const BUILDER_PREAMBLE = [
  'You are given a task in natural language. You start on a neutral bootstrap page.',
  'FIRST decide which website accomplishes the task and go there yourself with the navigate tool; if you do not know the exact URL, search from the current page.',
  'If the task needs an account, call generate_identity(platform) and use the $PLATFORM_NEW_* placeholders in fill/type_text; do not type literal placeholder text.',
  'If the site emails a confirmation code, call check_email. Solve CAPTCHAs with solve_captcha.',
  'Do not make purchases, submit payments, delete data, or perform irreversible/destructive actions.',
  'When finished, call done(value) with a concise JSON-serializable summary plus any data or credentials the task asked for.',
].join(' ');

/** The neutral page the deployment declares the agent starts on, refused by name when it declares none. */
function bootstrapUrl() {
  const declared = process.env.WELES_BUILDER_BOOTSTRAP_URL?.trim();
  if (!declared)
    throw new RouteRefusal(http.HTTP_STATUS_INTERNAL_SERVER_ERROR, {
      ok: false,
      error: 'missing_WELES_BUILDER_BOOTSTRAP_URL',
      message:
        'WELES_BUILDER_BOOTSTRAP_URL is not set: declare the neutral page the builder agent starts on',
    });
  return declared;
}

/** The goal the body states: its text, or the instructions member of a JSON body. */
function statedInstructions(raw) {
  const text = raw.trim();
  if (!text.startsWith('{')) return text;
  let document;
  try {
    document = JSON.parse(text);
  } catch (error) {
    throw new RouteRefusal(
      http.HTTP_STATUS_BAD_REQUEST,
      {
        ok: false,
        error: 'instructions_unreadable',
        message: `a JSON body must parse: ${error.message}`,
      },
      { cause: error },
    );
  }
  if (typeof document.instructions !== 'string')
    throw new RouteRefusal(http.HTTP_STATUS_BAD_REQUEST, {
      ok: false,
      error: 'instructions_unreadable',
      message: 'a JSON body carries its goal as the string member instructions',
    });
  return document.instructions.trim();
}

/** The caller's token check, refused by name when the worker holds no token to compare. */
function requireApiToken(req) {
  if (authorized(req)) return;
  if (TOKEN || ALLOW_UNAUTH)
    throw new RouteRefusal(http.HTTP_STATUS_UNAUTHORIZED, {
      ok: false,
      error: 'unauthorized',
    });
  throw new RouteRefusal(http.HTTP_STATUS_INTERNAL_SERVER_ERROR, {
    ok: false,
    error: 'missing_WELES_API_TOKEN',
  });
}

export async function respondToBuilder(req, res, runTrajectory) {
  let url;
  let instructions;
  try {
    requireApiToken(req);
    url = bootstrapUrl();
    instructions = statedInstructions(await readText(req));
    if (!instructions)
      throw new RouteRefusal(http.HTTP_STATUS_BAD_REQUEST, {
        ok: false,
        error: 'missing_instructions',
      });
  } catch (error) {
    answerRefusal(res, error);
    return;
  }
  const objective = `${BUILDER_PREAMBLE}\n\nTASK:\n${instructions}`;
  const out = await runTrajectory(
    'generic_browser_task',
    { url, objective },
    null,
    false,
  );
  if (out.error === 'no_trajectory') {
    json(res, http.HTTP_STATUS_INTERNAL_SERVER_ERROR, {
      ok: false,
      error: 'builder_trajectory_missing',
    });
    return;
  }
  const doc = out.result && typeof out.result === 'object' ? out.result : {};
  const stated = (member) => (Object.hasOwn(doc, member) ? doc[member] : null);
  const payload = {
    ok: out.ok,
    run_id: out.run_id,
    exitCode: out.exitCode,
    final_url: stated('final_url'),
    value: stated('value'),
    trajectory_draft: stated('trajectory_draft'),
    stdout_tail: out.stdout_tail,
    stderr_tail: out.stderr_tail,
  };
  // Returned unredacted (the result and credentials the task asked for are
  // the point of the run), unless raw credentials are forbidden globally.
  json(
    res,
    out.ok ? http.HTTP_STATUS_OK : http.HTTP_STATUS_BAD_GATEWAY,
    payload,
    { redact: !ALLOW_RAW_CREDS },
  );
}
