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
 * Submit a video generation (WanVideo/wavespeed/etc.) and return its job id.
 * Video generation is asynchronous; `videoFileForJob` reads where the job is.
 * @param {{prompt: string, mode?: string, pipeline?: string, reference_image_url?: string, character_id?: string, account_id?: string}} params
 */
export async function submitVideo(params) {
  const config = mediaConfig();
  const r = await fetch(`${config.endpoint}/video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders(config.token) },
    body: JSON.stringify(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.success || !data.job_id) throw new Error(`video submit ${r.status}: ${data.error ?? 'no job_id'}`);
  return data.job_id;
}

/**
 * One read of a submitted video job: `{ status: 'completed', path }` with the
 * downloaded file, or `{ status }` with the router's current state for a job
 * that is still running. A failed job throws with the router's error.
 */
export async function videoFileForJob(jobId) {
  const config = mediaConfig();
  const status = await fetch(`${config.endpoint}/video/${encodeURIComponent(jobId)}`, { headers: authHeaders(config.token) });
  if (!status.ok) throw new Error(`video status for job ${jobId} failed HTTP ${status.status}`);
  const state = await status.json();
  if (state.status === 'failed') throw new Error(`video generation ${jobId} failed: ${state.error ?? 'no error given'}`);
  if (state.status === 'completed') {
    return { status: 'completed', path: await downloadTo(`/video/${encodeURIComponent(jobId)}/content`, 'mp4', config) };
  }
  return { status: String(state.status ?? 'unknown') };
}
