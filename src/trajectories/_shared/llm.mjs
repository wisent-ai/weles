/**
 * Persona-voiced generation through Weles's scoped Stado model-router client.
 * Provider credentials and product CRON secrets never enter this process.
 */

const MODEL_ALIAS = 'weles-organic';

function routerConfig() {
  const rawUrl = String(process.env.STADO_MODEL_ROUTER_URL || '').trim();
  const token = String(process.env.WELES_STADO_MODEL_ROUTER_TOKEN || '').trim();
  if (!rawUrl || !token) throw new Error('missing exact Weles model-router configuration');
  const endpoint = new URL(rawUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
    throw new Error('invalid Weles model-router origin');
  }
  return { endpoint: endpoint.origin, token };
}

async function callGenerate(body) {
  const { endpoint, token } = routerConfig();
  const timeoutMs = Number(process.env.LLM_GENERATE_TIMEOUT_MS ?? '380000');
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(`${endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: MODEL_ALIAS,
        messages: [{ role: 'user', content: JSON.stringify(body) }],
      }),
      signal: ac.signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Stado model generation timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stado model generation ${res.status}: ${String(data.error?.message ?? '').slice(Number('0'), Number('200'))}`);
  const text = String(data.choices?.[Number('0')]?.message?.content ?? '').trim();
  if (!text) throw new Error('Stado model generation returned empty text');
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
