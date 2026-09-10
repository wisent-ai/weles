/**
 * Weles media client. All generation, status, and content transfer stays
 * behind the product-scoped Stado media-router bearer.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

function mediaConfig() {
  const rawUrl = String(process.env.STADO_MEDIA_ROUTER_URL || '').trim();
  const token = String(process.env.WELES_STADO_MEDIA_ROUTER_TOKEN || '').trim();
  if (!rawUrl || !token) throw new Error('missing exact Weles media-router configuration');
  const endpoint = new URL(rawUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
    throw new Error('invalid Weles media-router origin');
  }
  return { endpoint: endpoint.origin, token };
}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

async function downloadTo(path, ext, config) {
  const target = new URL(path, config.endpoint);
  if (target.origin !== config.endpoint) {
    throw new Error('media-router returned a provider locator instead of router-owned content');
  }
  const r = await fetch(target, { headers: authHeaders(config.token) });
  if (!r.ok) throw new Error(`media-router content download failed HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const dir = join(tmpdir(), 'weles-media');
  mkdirSync(dir, { recursive: true });
  const pathName = join(dir, `${randomUUID()}.${ext}`);
  writeFileSync(pathName, buf);
  return pathName;
}

/**
 * Generate an image (ComfyUI) and return a local file path.
 * @param {{prompt: string, style?: string, width?: number, height?: number, character_id?: string, account_id?: string}} params
 */
export async function generateImageFile(params) {
  const config = mediaConfig();
  const r = await fetch(`${config.endpoint}/image`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(config.token) },
    body: JSON.stringify(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.success || !data.content_url) {
    throw new Error(`image generation ${r.status}: ${data.error ?? 'router-owned content unavailable'}`);
  }
  return downloadTo(data.content_url, 'png', config);
}

/**
 * Generate a video (WanVideo/wavespeed/etc.) and return a local file path.
 * Video gen is async — poll the job until done or timeout (default 8 minutes).
 * @param {{prompt: string, mode?: string, pipeline?: string, reference_image_url?: string, character_id?: string, account_id?: string}} params
 */
export async function generateVideoFile(params, { timeoutMs = Number('480000'), pollMs = Number('5000') } = {}) {
  const config = mediaConfig();
  const r = await fetch(`${config.endpoint}/video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(config.token) },
    body: JSON.stringify(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.success || !data.job_id) throw new Error(`video submit ${r.status}: ${data.error ?? 'no job_id'}`);
  const jobId = data.job_id;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const status = await fetch(`${config.endpoint}/video/${encodeURIComponent(jobId)}`, { headers: authHeaders(config.token) });
    const state = await status.json().catch(() => ({}));
    if (state.status === 'completed') {
      return downloadTo(`/video/${encodeURIComponent(jobId)}/content`, 'mp4', config);
    }
    if (state.status === 'failed') throw new Error(`video generation failed: ${state.error ?? 'unknown'}`);
  }
  throw new Error(`video generation timed out after ${timeoutMs}ms`);
}
