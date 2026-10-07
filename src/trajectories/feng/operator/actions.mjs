import { closeOperatorRequest, openOperatorRequest } from '#operator-request';

export async function operatorAction(s, kind, instruction, observe, detail) {
  const request = openOperatorRequest({
    kind,
    account: `PARP browser session ${s.label} (process ${process.pid}; identity selected in the browser)`,
    run: s.label,
    instruction,
  });
  console.log(
    `[feng] prośba operatora: ${request.id}; powiadomienie przyjęte: ${request.pages.some((attempt) => attempt.ok)}`,
  );
  try {
    await observe();
  } catch (error) {
    try {
      closeOperatorRequest(
        request.id,
        false,
        `The browser stage failed: ${String(error?.message || error)}`,
      );
    } catch (closeError) {
      throw new AggregateError(
        [error, closeError],
        'FENG browser observation and operator-request closure failed',
      );
    }
    throw error;
  }
  closeOperatorRequest(request.id, true, detail);
}
