// Solvecha reCAPTCHA image grids (pictures only, no token tasks). The route is
// NopeCHA-compatible; Solvecha can hold the request until the answer exists, so
// the job is read without an interval of our own: the create request waits,
// and if the job is still open the answer read waits too (both are server-side
// waits, https://solvecha.com/openapi.json). Docs: https://solvecha.com/docs.
export const SOLVECHA_API_BASE = 'https://api.solvecha.com';
// Seconds the server may hold the create request, and then the answer read.
const CREATE_WAIT_SECONDS = 15;
const ANSWER_WAIT_SECONDS = 20;

export type SolvechaFetch = typeof fetch;

export async function solvechaGridSolve(
  key: string,
  instruction: string,
  gridImgB64: string,
  gridSize: number,
  fetchImpl: SolvechaFetch = fetch,
): Promise<number[] | null> {
  const headers = { Authorization: `Bearer ${key}` };
  const route = `${SOLVECHA_API_BASE}/v1/recognition/recaptcha`;
  try {
    const post = (await (
      await fetchImpl(`${route}?wait=${CREATE_WAIT_SECONDS}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task: instruction,
          image_data: [gridImgB64],
          grid: `${gridSize}x${gridSize}`,
        }),
      })
    ).json()) as any;
    let answer = post;
    if (typeof post?.data === 'string') {
      // The job was still open: read its answer with a server-side wait.
      answer = (await (
        await fetchImpl(
          `${route}?id=${encodeURIComponent(post.data)}&wait=${ANSWER_WAIT_SECONDS}`,
          { headers },
        )
      ).json()) as any;
    }
    if (Array.isArray(answer?.data))
      return (answer.data as boolean[])
        .map((v, i) => (v ? i + 1 : 0))
        .filter(Boolean);
    // 4xx answers carry errorId/errorCode/errorDescription; error 14 means not ready.
    const reason =
      answer?.errorDescription ??
      answer?.message ??
      (answer?.error === 14 ? 'grid job has no result yet' : null);
    if (reason)
      console.log(`[recaptcha] captcha_solvecha_failed: ${reason}`);
  } catch (error) {
    console.log(
      `[recaptcha] captcha_solvecha_failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return null;
}
