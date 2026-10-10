import { nextOperatorAnswer } from '#operator-request';

/** A page failure releases the operator-file watcher just like a successful page transition. */
export async function nextApprovalEvent(pageOutcome, requestId, seen) {
  const listening = new AbortController();
  try {
    return await Promise.race([
      pageOutcome,
      nextOperatorAnswer(requestId, seen, listening.signal).then(
        (operator) => ({ operator }),
      ),
    ]);
  } finally {
    listening.abort();
  }
}
