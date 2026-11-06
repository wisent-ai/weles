// One signup form submit, observed: the button clicked, the POST it sends
// awaited, its answer read and kept with the page state before and after. A
// submit that fails keeps its diagnostics under `label`; a diagnostics write
// that fails too is reported together with the failure it was keeping.
import { humanClickLocator } from '../../../../../dist/human/mouse.js';
import {
  pageSettled,
  responseAfterAction,
} from '../../../_shared/page/settled.mjs';
import {
  collectSubmitState,
  redactDiagnosticText,
  summarizeRequest,
  summarizeResponse,
  writeSubmitDiagnostics,
} from '../diagnostics.mjs';

const messageOf = (value) =>
  value instanceof Error ? value.message : String(value);

/**
 * Keep `error` in `diagnostics` and write them under `label`. Fields the
 * error does not carry are left out of the record.
 */
export async function recordSubmitFailure(label, diagnostics, error) {
  diagnostics.operation_error = {
    code: error.code,
    message: redactDiagnosticText(messageOf(error)),
    request_method: error.requestMethod,
    request_url: error.requestUrl,
    page_url: error.pageUrl,
    status: error.status,
    network_error: error.errorText,
    cause:
      error.cause === undefined
        ? undefined
        : redactDiagnosticText(messageOf(error.cause)),
  };
  try {
    await writeSubmitDiagnostics(label, diagnostics);
  } catch (diagnosticError) {
    throw new AggregateError(
      [error, diagnosticError],
      `${messageOf(error)}; and its diagnostics ${label} could not be written: ${messageOf(diagnosticError)}`,
    );
  }
}

export async function submitObserved(
  { session, recordStage },
  { button, pattern, stage, afterStage, label, before },
) {
  const diagnostics = { before };
  try {
    await button.waitFor({ state: 'visible' });
    if (!(await button.isEnabled()))
      throw Object.assign(
        new Error('LinkedIn signup submit button is disabled'),
        {
          code: 'LINKEDIN_SIGNUP_SUBMIT_DISABLED',
          pageUrl: session.page.url(),
        },
      );
    const response = await responseAfterAction(
      session.page,
      (request) => request.method() === 'POST' && pattern.test(request.url()),
      async () => {
        await humanClickLocator(session.page, button);
        recordStage(stage, { clicked: true });
      },
    );
    diagnostics.request = summarizeRequest(response.request());
    const responseState = {
      requestMethod: response.request().method(),
      requestUrl: response.url(),
      status: response.status(),
      pageUrl: session.page.url(),
    };
    let text;
    try {
      text = await response.text();
    } catch (cause) {
      diagnostics.response = summarizeResponse(response, null, cause);
      throw Object.assign(
        new Error('LinkedIn signup response body could not be read', { cause }),
        {
          code: 'LINKEDIN_SIGNUP_RESPONSE_FAILED',
          ...responseState,
        },
      );
    }
    diagnostics.response = summarizeResponse(response, text, null);
    if (!response.ok())
      throw Object.assign(
        new Error(`LinkedIn signup returned HTTP ${response.status()}`),
        {
          code: 'LINKEDIN_SIGNUP_HTTP_ERROR',
          ...responseState,
        },
      );
    await pageSettled(session.page);
    diagnostics.after = await collectSubmitState(session.page, afterStage);
    return { response, text, diagnostics };
  } catch (error) {
    await recordSubmitFailure(label, diagnostics, error);
    throw error;
  }
}
