/**
 * Worker-side helper for generating media attachments via the content-platform
 * /api/worker/media/image and /api/worker/media/video endpoints. Handles:
 *   1. POST to generate
 *   2. Wait / poll for completion (image: sync; video: async + poll)
 *   3. Download result to /tmp/<uuid>.<ext>
 *   4. Return the local path so trajectories can setInputFiles() it.
 *
 * Env required: CRON_SECRET. Optional: LLM_GENERATE_URL overrides the base
 * content-platform URL (same convention as llm.mjs).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';

function baseUrl() {
  const llm = process.env.LLM_GENERATE_URL || 'https://content.wisent.ai/api/llm/generate';
  return llm.replace(/\/api\/llm\/generate$/, '');
}
function secret() {
  const s = process.env.CRON_SECRET;
  if (!s) throw new Error('CRON_SECRET not set on worker env');
  return s;
}

async function downloadTo(url, ext) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`media download ${r.status} from ${url}`);
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
  const r = await fetch(`${baseUrl()}/api/worker/media/image`, {
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
  const r = await fetch(`${baseUrl()}/api/worker/media/video`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret() },
    body: JSON.stringify(params),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.success || !data.job_id) throw new Error(`video submit ${r.status}: ${data.error ?? 'no job_id'}`);
  const jobId = data.job_id;
  console.log(`[media] video job ${jobId} — polling`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, pollMs));
    const s = await fetch(`${baseUrl()}/api/worker/media/video?job_id=${jobId}`, {
      headers: { 'x-cron-secret': secret() },
    });
    const sd = await s.json().catch(() => ({}));
    if (sd.status === 'completed' && sd.url) {
      console.log(`[media] video: ${sd.url.slice(0, 80)}`);
      return downloadTo(sd.url, 'mp4');
    }
    if (sd.status === 'failed') throw new Error(`video gen failed: ${sd.error ?? 'unknown'}`);
  }
  throw new Error(`video gen timeout after ${timeoutMs}ms (job ${jobId})`);
}
