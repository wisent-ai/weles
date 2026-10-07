// One read of a captcha-solver task (anti-captcha / CapSolver getTaskResult
// API). The solver has no push or blocking answer, so this never waits: a task
// that is still being worked on is reported as a named error carrying the task
// id, and the caller decides whether to read again later with that id.

export async function solverTaskResult(svc, apiKey, taskId) {
  const response = await fetch(`${svc.url}/getTaskResult`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientKey: apiKey, taskId }),
  });
  if (!response.ok)
    throw new Error(
      `captcha_${svc.name}_http_${response.status}: getTaskResult for task ${taskId} failed`,
    );
  const res = await response.json();
  if (res.errorId)
    throw new Error(
      `captcha_${svc.name}_error: task ${taskId}: ${res.errorCode ?? 'error'} ${res.errorDescription ?? ''}`.trim(),
    );
  if (res.status !== 'ready') {
    throw new Error(
      `captcha_${svc.name}_processing: task ${taskId} has no result yet (status ${res.status ?? 'unknown'}); read it again with this task id`,
    );
  }
  const token = res.solution?.gRecaptchaResponse ?? res.solution?.token;
  if (!token)
    throw new Error(
      `captcha_${svc.name}_no_token: task ${taskId} is ready but its solution carries no token`,
    );
  return token;
}
