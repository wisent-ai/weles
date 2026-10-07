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
  if (!rawUrl || !token)
    throw new Error('missing exact Weles object client configuration');
  const endpoint = new URL(rawUrl);
  if (
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    (endpoint.pathname !== '/' && endpoint.pathname !== '')
  ) {
    throw new Error('invalid Weles Stado object origin');
  }
  return { endpoint: endpoint.origin, token };
}

// The avatar goes up as the operator stored it, made upright and cut to the
// square every profile picture is, its side the image's own shorter side.
// No size, format or quality is chosen here: the platform scales what it is
// given, and a re-encode would only lose what the stored image holds.
export async function loadAvatarFile(rawUrl) {
  if (!rawUrl) return null;

  if (!/^stado:\/\/weles\/avatars\/[^?#]+$/.test(rawUrl)) {
    throw new Error(
      'avatar locator must be a private stado://weles/avatars object',
    );
  }
  const config = stadoObjectConfig();
  const r = await fetch(
    `${config.endpoint}/api/object?uri=${encodeURIComponent(rawUrl)}`,
    {
      headers: { Authorization: `Bearer ${config.token}` },
    },
  );
  if (!r.ok) {
    throw new Error(
      `avatar ${rawUrl} could not be read from Stado's object store: HTTP ${r.status}`,
    );
  }
  const buf = Buffer.from(await r.arrayBuffer());

  const upright = await sharp(buf)
    .rotate()
    .toBuffer({ resolveWithObject: true });
  const side = Math.min(upright.info.width, upright.info.height);
  const out = await sharp(upright.data)
    .resize(side, side, { fit: 'cover', position: 'attention' })
    .toBuffer();

  const dir = join(tmpdir(), 'weles-avatars');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${randomUUID()}.${upright.info.format}`);
  writeFileSync(path, out);
  console.log(
    `[avatar-loader] ${upright.info.width}x${upright.info.height} ${upright.info.format} -> ${side}px square at ${path}`,
  );
  return path;
}
