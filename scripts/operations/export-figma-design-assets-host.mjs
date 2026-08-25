#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { createGzip } from 'node:zlib';

const endpoint = process.env.WELES_CREDENTIAL_SKARBIEC_URL || process.env.WC_SKARBIEC_URL;
const acquireScript = process.env.SKARBIEC_WELES_READER_COMMAND;
const scopeFile = process.env.SKARBIEC_WELES_ACQUISITION_SCOPES_FILE;
const repository = 'git@github.com:wisent-ai/design-assets.git';
const deployKey = join(process.env.HOME, '.stado', 'design-assets-deploy-key');
const checkout = join(process.env.HOME, '.stado', 'work', 'design-assets');
const inventoryLog = join(process.env.HOME, '.stado', 'weles-figma-ui-inventory.log');
const cacheRoot = join(process.env.HOME, '.stado', 'cache', 'figma-design-assets');
if (!endpoint || !acquireScript || !scopeFile) throw new Error('Figma exporter reader coordinates are incomplete');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || '').replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 500);
    throw new Error(`${basename(command)} failed: ${detail || `exit ${result.status}`}`);
  }
  return result.stdout;
}

const acquired = spawnSync(process.execPath, [
  acquireScript,
  endpoint,
  scopeFile,
  'weles-figma-design-assets-exporter',
  'weles-figma-personal-access-token',
  'api_key',
], { encoding: 'buffer', env: process.env, maxBuffer: 65536 });
if (acquired.status !== 0) throw new Error('Figma token acquisition failed');
const tokenBuffer = acquired.stdout;

function slugify(value) {
  const slug = String(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'untitled';
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function extensionFor(contentType, url) {
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
async function request(url, options = {}, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response;
    try {
      response = await fetch(url, options);
    } catch (error) {
      if (attempt + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(30000, 1000 * (2 ** attempt))));
        continue;
      }
      const code = error?.cause?.code || error?.code || 'network-error';
      throw new Error(`Figma network failure for ${new URL(url).pathname}: ${code}`);
    }
    if (response.ok) return response;
    const body = await response.text();
    if ((response.status === 429 || response.status >= 500) && attempt + 1 < attempts) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(30000, 1000 * (2 ** attempt));
      await new Promise((resolve) => setTimeout(resolve, delay));
      continue;
    }
    const reason = body.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]').slice(0, 240);
    throw new Error(`Figma HTTP ${response.status} for ${new URL(url).pathname}: ${reason}`);
  }
  throw new Error(`Figma request attempts exhausted for ${new URL(url).pathname}`);
}

async function figmaJson(path) {
  const bearer = tokenBuffer.toString('utf8');
  const response = await request(`https://api.figma.com${path}`, {
    headers: { 'X-Figma-Token': bearer },
  });
  return response.json();
}
async function figmaDocument(fileKey, nodesPath) {
  mkdirSync(cacheRoot, { recursive: true });
  const cachePath = join(cacheRoot, `${fileKey}.json`);
  if (!existsSync(cachePath)) {
    const bearer = tokenBuffer.toString('utf8');
    const response = await request(`https://api.figma.com/v1/files/${fileKey}`, {
      headers: { 'X-Figma-Token': bearer },
    });
    writeFileSync(cachePath, Buffer.from(await response.arrayBuffer()));
  }
  const summaryPath = join(cacheRoot, `${fileKey}.summary.json`);
  run('/usr/bin/python3', [
    process.env.FIGMA_JSON_PARSER,
    cachePath,
    summaryPath,
    nodesPath,
  ]);
  return {
    cachePath,
    bytes: statSync(cachePath).size,
    summary: JSON.parse(readFileSync(summaryPath, 'utf8')),
  };
}

async function gzipFile(source, destination) {
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

async function download(url, destination) {
  const response = await request(url, {}, 4);
  const buffer = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, buffer);
  return {
    bytes: buffer.length,
    sha256: sha256(buffer),
    contentType: response.headers.get('content-type') || 'application/octet-stream',
  };
}

function collectNodes(document) {
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

async function renderNodes(fileKey, nodes, destination, format, scale = 1) {
  const rendered = [];
  const batches = [];
  for (let index = 0; index < nodes.length; index += 80) {
    batches.push(nodes.slice(index, index + 80));
  }
  for (const batch of batches) {
    const ids = batch.map((node) => node.id).join(',');
    const payload = await figmaJson(
      `/v1/images/${fileKey}?ids=${encodeURIComponent(ids)}&format=${encodeURIComponent(format)}&scale=${scale}`,
    );
    for (const node of batch) {
      const url = payload.images?.[node.id];
      if (!url) {
        rendered.push({ ...node, status: 'unavailable', format, scale });
        continue;
      }
      const extension = format === 'jpg' ? '.jpg' : `.${format}`;
      const path = join(destination, `${slugify(node.name)}-${node.id.replace(/[^a-z0-9]/gi, '-')}${extension}`);
      const artifact = await download(url, path);
      rendered.push({
        ...node,
        status: 'downloaded',
        format,
        scale,
        path,
        ...artifact,
      });
    }
  }
  return rendered;
}

try {
  const lines = readFileSync(inventoryLog, 'utf8').trim().split(/\r?\n/);
  const inventory = JSON.parse(lines.at(-1));
  const files = (inventory.companyFiles || [])
    .filter((entry) => /wisent|team library/i.test(entry.name))
    .map((entry) => {
      const match = entry.url?.match(/figma\.com\/(design|file|board|slides|make|proto)\/([^/?]+)/i);
      if (!match) throw new Error(`Figma file key is unavailable for ${entry.name}`);
      return { name: entry.name, type: match[1].toLowerCase(), key: match[2] };
    });
  if (files.length === 0) throw new Error('Figma inventory contains no files');

  rmSync(checkout, { recursive: true, force: true });
  mkdirSync(dirname(checkout), { recursive: true });
  const gitEnv = {
    ...process.env,
    GIT_SSH_COMMAND: `/usr/bin/ssh -i ${deployKey} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`,
  };
  run('/usr/bin/git', ['clone', repository, checkout], { env: gitEnv });
  const exportRoot = join(checkout, 'figma.next');
  rmSync(exportRoot, { recursive: true, force: true });
  mkdirSync(exportRoot, { recursive: true });

  const exportSummary = [];
  for (const file of files) {
    const folder = `${slugify(file.name)}-${file.key.slice(0, 8)}`;
    const fileRoot = join(exportRoot, 'files', folder);
    mkdirSync(fileRoot, { recursive: true });
    console.error(`exporting ${file.name}: document`);
    const nodesPath = join(fileRoot, 'nodes.json');
    const documentResponse = await figmaDocument(file.key, nodesPath);
    const collected = {
      nodes: JSON.parse(readFileSync(nodesPath, 'utf8')),
      topLevelNodes: documentResponse.summary.topLevelNodes,
      exportNodes: documentResponse.summary.exportNodes,
    };
    const compressedPath = join(fileRoot, 'document.json.gz');
    await gzipFile(documentResponse.cachePath, compressedPath);

    console.error(`exporting ${file.name}: source images`);
    const sourceImages = await figmaJson(`/v1/files/${file.key}/images`);
    const imageManifest = [];
    for (const [imageRef, url] of Object.entries(sourceImages.meta?.images || {})) {
      if (!url) continue;
      const response = await request(url, {}, 4);
      const buffer = Buffer.from(await response.arrayBuffer());
      const extension = extensionFor(response.headers.get('content-type'), url);
      const relative = join('assets', 'images', `${imageRef}${extension}`);
      const absolute = join(fileRoot, relative);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, buffer);
      imageManifest.push({
        imageRef,
        path: relative,
        bytes: buffer.length,
        sha256: sha256(buffer),
        contentType: response.headers.get('content-type') || 'application/octet-stream',
      });
    }

    console.error(`exporting ${file.name}: previews`);
    const previewRoot = join(fileRoot, 'assets', 'previews');
    const previewManifest = await renderNodes(file.key, collected.topLevelNodes, previewRoot, 'png', 1);
    for (const entry of previewManifest) {
      if (entry.path) entry.path = entry.path.slice(fileRoot.length + 1);
    }

    const explicitManifest = collected.exportNodes.map((node) => ({
      id: node.id,
      name: node.name,
      settings: node.settings,
      status: 'declared',
    }));

    const metadata = {
      name: file.name,
      key: file.key,
      sourceType: file.type,
      sourceUrl: `https://www.figma.com/${file.type}/${file.key}`,
      version: documentResponse.summary.version,
      lastModified: documentResponse.summary.lastModified || null,
      documentBytes: documentResponse.bytes,
      documentSha256: sha256(readFileSync(documentResponse.cachePath)),
      compressedDocumentBytes: statSync(compressedPath).size,
      nodeCount: collected.nodes.length,
      componentCount: documentResponse.summary.components,
      componentSetCount: documentResponse.summary.componentSets,
      styleCount: documentResponse.summary.styles,
      sourceImageCount: imageManifest.length,
      previewCount: previewManifest.filter((entry) => entry.status === 'downloaded').length,
      explicitExportCount: explicitManifest.length,
    };
    writeFileSync(join(fileRoot, 'assets.json'), `${JSON.stringify({ images: imageManifest, previews: previewManifest, exports: explicitManifest }, null, 2)}\n`);
    writeFileSync(join(fileRoot, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    exportSummary.push({ folder, ...metadata });
  }

  const generatedAt = new Date().toISOString();
  writeFileSync(join(exportRoot, 'inventory.json'), `${JSON.stringify({ generatedAt, teamId: '1496228249916610388', files: exportSummary }, null, 2)}\n`);
  const currentRoot = join(checkout, 'figma');
  rmSync(currentRoot, { recursive: true, force: true });
  run('/bin/mv', [exportRoot, currentRoot]);
  run('/usr/bin/git', ['-C', checkout, 'add', 'figma'], { env: gitEnv });
  const changes = run('/usr/bin/git', ['-C', checkout, 'status', '--porcelain'], { env: gitEnv }).trim();
  if (changes) {
    run('/usr/bin/git', ['-C', checkout, '-c', 'user.name=Wisent Automation', '-c', 'user.email=automation@wisent.com', 'commit', '-m', `Export Figma design assets ${generatedAt.slice(0, 10)}`], { env: gitEnv });
    run('/usr/bin/git', ['-C', checkout, 'push', 'origin', 'HEAD:main'], { env: gitEnv });
  }
  console.log(JSON.stringify({
    status: changes ? 'published' : 'unchanged',
    repository: 'wisent-ai/design-assets',
    commit: run('/usr/bin/git', ['-C', checkout, 'rev-parse', 'HEAD'], { env: gitEnv }).trim(),
    files: exportSummary.map((file) => ({
      name: file.name,
      key: file.key,
      nodes: file.nodeCount,
      sourceImages: file.sourceImageCount,
      previews: file.previewCount,
      exports: file.explicitExportCount,
    })),
  }));
} finally {
  tokenBuffer.fill(0);
  if (Buffer.isBuffer(acquired.stderr)) acquired.stderr.fill(0);
}
