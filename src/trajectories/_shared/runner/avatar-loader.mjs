// Loads a private Weles avatar through the exact Stado object client.
// Provider URLs and cross-product proxy paths are rejected.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import sharp from 'sharp';

function stadoObjectConfig() {
  const rawUrl = String(process.env.STADO_API_URL || '').trim();
  const token = String(process.env.WELES_STADO_OBJECT_API_TOKEN || '').trim();
  if (!rawUrl || !token) throw new Error('missing exact Weles object client configuration');
  const endpoint = new URL(rawUrl);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
      || (endpoint.pathname !== '/' && endpoint.pathname !== '')) {
    throw new Error('invalid Weles Stado object origin');
  }
  return { endpoint: endpoint.origin, token };
}

export async function loadAvatarFile(rawUrl, opts = {}) {
  if (!rawUrl) return null;
  const size = opts.size || 512;
  const format = opts.format || 'jpeg';
  const quality = opts.quality || 88;

  if (!/^stado:\/\/weles\/avatars\/[^?#]+$/.test(rawUrl)) {
    throw new Error('avatar locator must be a private stado://weles/avatars object');
  }
  const config = stadoObjectConfig();
  const r = await fetch(`${config.endpoint}/api/object?uri=${encodeURIComponent(rawUrl)}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!r.ok) {
    console.log(`[avatar-loader] Stado object fetch failed HTTP ${r.status}`);
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
