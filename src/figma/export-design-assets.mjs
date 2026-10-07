#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import {
  download,
  extensionFor,
  gzipFile,
  request,
  sha256,
  slugify,
} from './transfer.mjs';
import { parseFigmaDocument } from './document/parse-figma-document.mjs';
import { readExportRequest } from './export-request.mjs';
import { prepareExport } from './export-checkout.mjs';

export async function exportDesignAssets(requestPath) {
  const input = readExportRequest(requestPath);
  const workspace = prepareExport(input);
  const { exportRoot, cacheRoot } = workspace;
  const acquireScript =
    process.env.SKARBIEC_WELES_READER_COMMAND ||
    join(
      import.meta.dirname,
      '..',
      'worker',
      'deploy',
      'acquire',
      'skarbiec-acquire.mjs',
    );
  let acquired;
  let tokenBuffer;
  let success = false;

  async function figmaJson(path) {
    const bearer = tokenBuffer.toString('utf8');
    const response = await request(`https://api.figma.com${path}`, {
      headers: { 'X-Figma-Token': bearer },
    });
    return response.json();
  }
  async function figmaDocument(fileKey, nodesPath, vocabularyPath) {
    mkdirSync(cacheRoot, { recursive: true });
    const cachePath = join(cacheRoot, `${fileKey}.json`);
    if (!existsSync(cachePath)) {
      const bearer = tokenBuffer.toString('utf8');
      const response = await request(
        `https://api.figma.com/v1/files/${fileKey}`,
        {
          headers: { 'X-Figma-Token': bearer },
        },
      );
      writeFileSync(cachePath, Buffer.from(await response.arrayBuffer()));
    }
    const summaryPath = join(cacheRoot, `${fileKey}.summary.json`);
    // One parse writes the node index and the design vocabulary — the colour
    // variables, named styles, fonts, radii, gradients and blurs the designer
    // defined on visible layers — which wisent-components merges into the set
    // its design lint holds every web repository to.
    parseFigmaDocument(cachePath, summaryPath, nodesPath, vocabularyPath);
    return {
      cachePath,
      bytes: statSync(cachePath).size,
      summary: JSON.parse(readFileSync(summaryPath, 'utf8')),
    };
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
        const path = join(
          destination,
          `${slugify(node.name)}-${node.id.replace(/[^a-z0-9]/gi, '-')}${extension}`,
        );
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
    acquired = spawnSync(
      process.execPath,
      [acquireScript, input.scopeFile, input.consumer, input.item, input.field],
      {
        encoding: 'buffer',
        env: {
          ...process.env,
          WC_SKARBIEC_URL: input.endpoint,
          SKARBIEC_WORKLOAD_ID: input.workloadId,
          SKARBIEC_WORKLOAD_SIGNING_KEY_FILE: input.signingKeyFile,
        },
        maxBuffer: 65536,
      },
    );
    tokenBuffer = acquired.stdout;
    if (acquired.status !== 0) {
      const detail = String(
        acquired.stderr || acquired.error?.message || acquired.signal || '',
      ).replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]');
      throw new Error(
        `Figma credential acquisition failed (exit ${acquired.status}): ${detail.trim()}`,
      );
    }
    if (!Buffer.isBuffer(tokenBuffer) || !tokenBuffer.length)
      throw new Error('Figma credential acquisition returned an empty token');

    const exportSummary = [];
    for (const file of input.files) {
      const folder = `${slugify(file.name)}-${file.key}`;
      const fileRoot = join(exportRoot, 'files', folder);
      mkdirSync(fileRoot, { recursive: true });
      console.error(`exporting ${file.name}: document`);
      const nodesPath = join(fileRoot, 'nodes.json');
      const documentResponse = await figmaDocument(
        file.key,
        nodesPath,
        join(fileRoot, 'vocabulary.json'),
      );
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
      for (const [imageRef, url] of Object.entries(
        sourceImages.meta?.images || {},
      )) {
        if (!url) continue;
        const response = await request(url, {});
        const buffer = Buffer.from(await response.arrayBuffer());
        const extension = extensionFor(
          response.headers.get('content-type'),
          url,
        );
        const relative = join('assets', 'images', `${imageRef}${extension}`);
        const absolute = join(fileRoot, relative);
        mkdirSync(dirname(absolute), { recursive: true });
        writeFileSync(absolute, buffer);
        imageManifest.push({
          imageRef,
          path: relative,
          bytes: buffer.length,
          sha256: sha256(buffer),
          contentType:
            response.headers.get('content-type') || 'application/octet-stream',
        });
      }

      console.error(`exporting ${file.name}: previews`);
      const previewRoot = join(fileRoot, 'assets', 'previews');
      const previewManifest = await renderNodes(
        file.key,
        collected.topLevelNodes,
        previewRoot,
        'png',
        1,
      );
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
        previewCount: previewManifest.filter(
          (entry) => entry.status === 'downloaded',
        ).length,
        explicitExportCount: explicitManifest.length,
      };
      writeFileSync(
        join(fileRoot, 'assets.json'),
        `${JSON.stringify({ images: imageManifest, previews: previewManifest, exports: explicitManifest }, null, 2)}\n`,
      );
      writeFileSync(
        join(fileRoot, 'metadata.json'),
        `${JSON.stringify(metadata, null, 2)}\n`,
      );
      exportSummary.push({ folder, ...metadata });
    }

    const generatedAt = new Date().toISOString();
    writeFileSync(
      join(exportRoot, 'inventory.json'),
      `${JSON.stringify({ generatedAt, teamId: input.teamId, files: exportSummary }, null, 2)}\n`,
    );
    const publication = workspace.publish(generatedAt);
    success = true;
    console.log(
      JSON.stringify({
        ...publication,
        files: exportSummary.map((file) => ({
          name: file.name,
          key: file.key,
          nodes: file.nodeCount,
          sourceImages: file.sourceImageCount,
          previews: file.previewCount,
          exports: file.explicitExportCount,
        })),
      }),
    );
  } finally {
    if (Buffer.isBuffer(tokenBuffer)) tokenBuffer.fill(0);
    if (Buffer.isBuffer(acquired?.stderr)) acquired.stderr.fill(0);
    workspace.close(success);
  }
}
