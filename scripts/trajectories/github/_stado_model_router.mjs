const ROUTER_PATH = '/v1/chat/completions';
const MULTIMODAL_SELECTOR = 'any-vision-capable';
for (const providerCredentialName of [
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
  'VERTEX_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'WELES_GEMINI_MODEL',
]) {
  delete process.env[providerCredentialName];
}

let routerConfig = null;

function requiredEnv(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`missing required ${name}`);
  return value;
}


export function requireStadoModelRouterConfig() {
  if (routerConfig) return routerConfig;
  const rawUrl = requiredEnv('STADO_MODEL_ROUTER_URL');
  const token = requiredEnv('WELES_STADO_MODEL_ROUTER_TOKEN');
  if (Buffer.byteLength(token) < Number('32')) {
    throw new Error('WELES_STADO_MODEL_ROUTER_TOKEN must contain at least 32 bytes');
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('STADO_MODEL_ROUTER_URL must be a valid URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash
    || (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new Error('STADO_MODEL_ROUTER_URL must be an origin without credentials, path, query, or fragment');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '::1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) {
    throw new Error('STADO_MODEL_ROUTER_URL must use HTTPS, except for loopback HTTP');
  }
  for (const siblingName of ['WELES_STADO_OBJECT_API_TOKEN', 'WELES_STADO_MEDIA_ROUTER_TOKEN', 'WELES_ARTIFACT_DELIVERY_TOKEN', 'WELES_ARTIFACT_SIGNING_SECRET']) {
    const sibling = String(process.env[siblingName] || '').trim();
    if (sibling && sibling === token) {
      throw new Error(`WELES_STADO_MODEL_ROUTER_TOKEN must be distinct from ${siblingName}`);
    }
  }
  routerConfig = { baseUrl: parsed.origin, token };
  return routerConfig;
}

function completionText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => typeof part === 'string' ? part : (typeof part?.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

export async function completeMultimodal({ base64, mimeType, prompt, maxTokens }) {
  if (!/^(?:audio|image)\/[a-z\d.+-]+$/i.test(String(mimeType || ''))) {
    throw new Error(`unsupported Stado model-router media type: ${mimeType || 'missing'}`);
  }
  if (typeof base64 !== 'string' || !base64) throw new Error('Stado model-router media payload is empty');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Stado model-router prompt is empty');
  if (!Number.isInteger(maxTokens) || maxTokens < Number(true)) throw new Error('Stado model-router maxTokens must be a positive integer');

  const config = requireStadoModelRouterConfig();
  const response = await fetch(`${config.baseUrl}${ROUTER_PATH}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MULTIMODAL_SELECTOR,
      temperature: Number(false),
      max_tokens: maxTokens,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      }],
    }),
  });
  const responseText = await response.text();
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw new Error(`Stado model-router returned invalid JSON (HTTP ${response.status})`);
  }
  if (!response.ok) {
    const detail = typeof payload?.error?.message === 'string' ? payload.error.message : responseText;
    throw new Error(`Stado model-router HTTP ${response.status}: ${String(detail).slice(Number(false), Number('240'))}`);
  }
  const text = completionText(payload?.choices?.at(Number(false))?.message?.content);
  if (!text) throw new Error('Stado model-router returned an empty completion');
  return { text, model: typeof payload.model === 'string' ? payload.model : MULTIMODAL_SELECTOR };
}
