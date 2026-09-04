#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const teamId = '1496228249916610388';
const endpoint = process.env.WC_SKARBIEC_URL;
const acquireScript = process.env.SKARBIEC_WELES_READER_COMMAND;
const scopeFile = process.env.SKARBIEC_WELES_ACQUISITION_SCOPES_FILE;
if (!endpoint || !acquireScript || !scopeFile) throw new Error('Figma inventory reader coordinates are incomplete');
const acquired = spawnSync(process.execPath, [
  acquireScript,
  scopeFile,
  'weles-figma-design-assets-exporter',
  'weles-figma-personal-access-token',
  'api_key',
], { encoding: 'buffer', env: process.env, maxBuffer: 65536 });
if (acquired.status !== 0) throw new Error('Figma token acquisition failed');
const token = acquired.stdout;
try {
  const bearer = token.toString('utf8');
  if (bearer.length < 20 || /\s/.test(bearer)) throw new Error('Figma token acquisition returned an invalid value');
  async function figma(path) {
    const response = await fetch(`https://api.figma.com${path}`, {
      headers: { 'X-Figma-Token': bearer },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const reason = typeof payload?.message === 'string'
        ? payload.message
        : typeof payload?.err === 'string' ? payload.err : 'no response detail';
      throw new Error(`Figma ${path} failed with HTTP ${response.status}: ${reason.slice(0, 240)}`);
    }
    return payload;
  }
  const projectsPayload = await figma(`/v1/teams/${teamId}/projects`);
  const projects = [];
  for (const project of projectsPayload.projects || []) {
    const filesPayload = await figma(`/v1/projects/${encodeURIComponent(project.id)}/files`);
    projects.push({
      id: String(project.id),
      name: String(project.name || ''),
      files: (filesPayload.files || []).map((file) => ({
        key: String(file.key),
        name: String(file.name || ''),
        lastModified: file.last_modified || null,
      })),
    });
  }
  console.log(JSON.stringify({ teamId, projects }));
} finally {
  token.fill(0);
  if (Buffer.isBuffer(acquired.stderr)) acquired.stderr.fill(0);
}
