// Transfer helpers the Figma exporter uses that carry no credential: naming,
// digests, the retrying fetch, gzip, download and the node walk. The token
// and the Figma API calls stay in export-design-assets.mjs.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';
import { createGzip } from 'node:zlib';

export function slugify(value) {
  const slug = String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'untitled';
}

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function extensionFor(contentType, url) {
  const mime = String(contentType || '').split(';')[0].toLowerCase();
  const byMime = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/svg+xml': '.svg',
    'image/webp': '.webp',
    'application/pdf': '.pdf',
  };
  const fromUrl = extname(new URL(url).pathname).toLowerCase();
  return byMime[mime] || (/^\.(?:png|jpe?g|gif|svg|webp|pdf)$/.test(fromUrl) ? fromUrl : '.bin');
}
/** One request. A network failure or a non-2xx answer is the error, with the
 * status, the server's Retry-After when it sent one, and the redacted body. */
export async function request(url, options = {}) {
  const path = new URL(url).pathname;
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const code = error?.cause?.code || error?.code || 'network-error';
    throw new Error(`Figma network failure for ${path}: ${code}`);
  }
  if (response.ok) return response;
  const body = await response.text();
  const retryAfter = response.headers.get('retry-after');
  const reason = body.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 240);
  const after = retryAfter ? ` (Retry-After: ${retryAfter})` : '';
  throw new Error(`Figma HTTP ${response.status} for ${path}${after}: ${reason}`);
}

export async function gzipFile(source, destination) {
  await new Promise((resolve, reject) => {
    const input = createReadStream(source);
    const output = createWriteStream(destination);
    const gzip = createGzip({ level: 9, mtime: 0 });
    input.on('error', reject);
    gzip.on('error', reject);
    output.on('error', reject);
    output.on('finish', resolve);
    input.pipe(gzip).pipe(output);
  });
}

export async function download(url, destination) {
  const response = await request(url, {});
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, buffer);
  return {
    bytes: buffer.length,
    sha256: sha256(buffer),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
}

export function collectNodes(document) {
  const nodes = [];
  const imageRefs = new Set();
  const exportNodes = [];
  const topLevelNodes = [];
  const stack = [document];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    nodes.push({ id: node.id, name: node.name || '', type: node.type || '' });
    for (const fill of [...(node.fills || []), ...(node.strokes || [])]) {
      if (fill?.type === 'IMAGE' && typeof fill.imageRef === 'string') imageRefs.add(fill.imageRef);
    }
    if (Array.isArray(node.exportSettings) && node.exportSettings.length > 0) {
      exportNodes.push({ id: node.id, name: node.name || '', settings: node.exportSettings });
    }
    if (node.type === 'CANVAS') {
      for (const child of node.children || []) topLevelNodes.push({ id: child.id, name: child.name || '', page: node.name || '' });
    }
    for (const child of node.children || []) stack.push(child);
  }
  return { nodes, imageRefs, exportNodes, topLevelNodes };
}
