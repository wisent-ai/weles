/**
 * Persona-voiced comment generator. Replaces the former
 * api.wisentmedia.com/api/llm/messages Claude-proxy call. Posts to the
 * content-platform /api/llm/generate route, which wraps the AuthorMist
 * RunPod endpoint and returns synchronously when the job completes.
 *
 * Env required:
 *   CRON_SECRET                 — matches content-platform's CRON_SECRET
 *   LLM_GENERATE_URL (optional) — overrides the default production URL
 */

const DEFAULT_URL = 'https://content.wisent.ai/api/llm/generate';

function endpoint() {
  return process.env.LLM_GENERATE_URL || DEFAULT_URL;
}

async function callGenerate(body) {
  const secret = process.env.CRON_SECRET;
  if (!secret) throw new Error('CRON_SECRET not set on worker env');
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`llm.generate ${res.status}: ${data.error ?? (await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const text = (data.text || '').trim();
  if (!text) throw new Error('llm.generate returned empty text');
  return text;
}

export async function generateOrganicComment({ persona, post }) {
  return callGenerate({ task: 'organic_comment', persona, post });
}

export async function generatePromoteComment({ persona, post, product }) {
  return callGenerate({ task: 'promote', persona, post, product });
}

export async function generatePost({ persona, surface, product }) {
  const task = product ? 'post_promote' : 'post';
  return callGenerate({ task, persona, surface, product });
}
