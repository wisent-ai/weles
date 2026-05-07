// Fetches a character avatar (typically a 1.5MB+ training image) from
// content-platform's /api/gcs-image proxy, downscales it and writes a temp
// JPEG suitable for platform avatar upload. github is the strictest at 1MB,
// so 512px JPEG quality 88 (50-150KB typical) clears every platform.
//
// Returns the absolute temp path or null on failure.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

function absolutizeMediaUrl(url) {
  if (/^https?:\/\//.test(url)) return url;
  const base = (process.env.LLM_GENERATE_URL || 'https://content.wisent.ai/api/llm/generate')
    .replace(/\/api\/llm\/generate$/, '');
  return `${base}${url.startsWith('/') ? url : `/${url}`}`;
}

export async function loadAvatarFile(rawUrl, opts = {}) {
  if (!rawUrl) return null;
  const size = opts.size || 512;
  const format = opts.format || 'jpeg';
  const quality = opts.quality || 88;

  const absUrl = absolutizeMediaUrl(rawUrl);
  const headers = {};
  if (absUrl.includes('/api/') && process.env.CRON_SECRET) {
    headers['x-cron-secret'] = process.env.CRON_SECRET;
  }
  const r = await fetch(absUrl, { headers });
  if (!r.ok) {
    console.log(`[avatar-loader] fetch ${r.status} from ${absUrl}`);
    return null;
  }
  const buf = Buffer.from(await r.arrayBuffer());

  let pipeline = sharp(buf).rotate().resize(size, size, { fit: 'cover', position: 'attention' });
  if (format === 'jpeg') pipeline = pipeline.jpeg({ quality, mozjpeg: true });
  else if (format === 'png') pipeline = pipeline.png({ compressionLevel: 9 });
  const out = await pipeline.toBuffer();

  const dir = join(tmpdir(), 'weles-avatars');
  mkdirSync(dir, { recursive: true });
  const ext = format === 'jpeg' ? 'jpg' : format;
  const path = join(dir, `${randomUUID()}.${ext}`);
  writeFileSync(path, out);
  console.log(`[avatar-loader] ${(buf.length / 1024).toFixed(0)}KB -> ${(out.length / 1024).toFixed(0)}KB ${size}px ${format} at ${path}`);
  return path;
}
