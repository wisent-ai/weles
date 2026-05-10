/**
 * Worker-side helper for generating media attachments.
 *
 * Two code paths:
 * 1. Default: POSTs to content-platform's /api/worker/media/{image,video}
 *    (which currently hosts the generation logic).
 * 2. IMAGE_VIDEO_ROUTER_URL set: POSTs directly to the standalone router
 *    service at that base URL. Skips content-platform entirely — important
 *    for /image because content-platform on Vercel times out before
 *    synchronous ComfyUI calls complete.
 *
 * Env required: CRON_SECRET. Optional: IMAGE_VIDEO_ROUTER_URL (direct),
 * LLM_GENERATE_URL (overrides content-platform base URL).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

// { base, path } — base URL + endpoint path, for one of the two code paths.
function imageRoute() {
  if (process.env.IMAGE_VIDEO_ROUTER_URL) {
    return { base: process.env.IMAGE_VIDEO_ROUTER_URL.replace(/\/$/, ''), path: '/image' };
  }
  const llm = process.env.LLM_GENERATE_URL || 'https://content.wisent.ai/api/llm/generate';
  return { base: llm.replace(/\/api\/llm\/generate$/, ''), path: '/api/worker/media/image' };
}
function videoRoute() {
  if (process.env.IMAGE_VIDEO_ROUTER_URL) {
    return { base: process.env.IMAGE_VIDEO_ROUTER_URL.replace(/\/$/, ''), path: '/video' };
  }
  const llm = process.env.LLM_GENERATE_URL || 'https://content.wisent.ai/api/llm/generate';
  return { base: llm.replace(/\/api\/llm\/generate$/, ''), path: '/api/worker/media/video' };
}
function secret() {
  const s = process.env.CRON_SECRET;
  if (!s) throw new Error('CRON_SECRET not set on worker env');
  return s;
}

// content-platform's image route returns output_url as a relative
// /api/gcs-image?path=... path. fetch() in Node needs an absolute URL —
// resolve against the LLM_GENERATE_URL host. Worker's secret is required for
// /api/gcs-image since it's a protected route.
function absolutizeMediaUrl(url) {
  if (/^https?:\/\//.test(url)) return url;
  const base = (process.env.LLM_GENERATE_URL || 'https://content.wisent.ai/api/llm/generate')
    .replace(/\/api\/llm\/generate$/, '');
  return `${base}${url.startsWith('/') ? url : `/${url}`}`;
}

async function downloadTo(url, ext) {
  const absUrl = absolutizeMediaUrl(url);
  const r = await fetch(absUrl, absUrl.includes('/api/') ? { headers: { 'x-cron-secret': secret() } } : {});
  if (!r.ok) throw new Error(`media download ${r.status} from ${absUrl}`);
  const buf = Buffer.from(await r.arrayBuffer());
  const dir = join(tmpdir(), 'weles-media');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${ext}`);
  writeFileSync(path, buf);
  return path;
}

/**
 * Generate an image (ComfyUI) and return a local file path.
 * @param {{prompt: string, style?: string, width?: number, height?: number, character_id?: string, account_id?: string}} params
 */
export async function generateImageFile(params) {
  const { base, path } = imageRoute();
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret() },
    body: JSON.stringify(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.success || !data.url) throw new Error(`image gen ${r.status}: ${data.error ?? 'no url'}`);
  console.log(`[media] image: ${data.url.slice(0, 80)}`);
  return downloadTo(data.url, 'png');
}

/**
 * Generate a video (WanVideo/wavespeed/etc.) and return a local file path.
 * Video gen is async — poll the job until done or timeout (default 8 minutes).
 * @param {{prompt: string, mode?: string, pipeline?: string, reference_image_url?: string, character_id?: string, account_id?: string}} params
 */
export async function generateVideoFile(params, { timeoutMs = 480000, pollMs = 5000 } = {}) {
  const { base, path } = videoRoute();
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret() },
    body: JSON.stringify(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.success || !data.job_id) throw new Error(`video submit ${r.status}: ${data.error ?? 'no job_id'}`);
  const jobId = data.job_id;
  console.log(`[media] video job ${jobId} — polling`);
  const deadline = Date.now() + timeoutMs;
  // Status URL differs: router is REST-style /video/<id>; content-platform is query-param.
  const statusUrl = process.env.IMAGE_VIDEO_ROUTER_URL
    ? `${base}${path}/${encodeURIComponent(jobId)}`
    : `${base}${path}?job_id=${encodeURIComponent(jobId)}`;
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, pollMs));  // allow-raw-playwright: polling/rate-limit loop
    const s = await fetch(statusUrl, { headers: { 'x-cron-secret': secret() } });
    const sd = await s.json().catch(() => ({}));
    if (sd.status === 'completed' && sd.url) {
      console.log(`[media] video: ${sd.url.slice(0, 80)}`);
      return downloadTo(sd.url, 'mp4');
    }
    if (sd.status === 'failed') throw new Error(`video gen failed: ${sd.error ?? 'unknown'}`);
  }
  throw new Error(`video gen timeout after ${timeoutMs}ms (job ${jobId})`);
}
