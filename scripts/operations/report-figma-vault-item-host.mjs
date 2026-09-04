#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { activeSkarbiecBinary } from '../_shared/skarbiec-runtime.mjs';

const skarbiec = activeSkarbiecBinary();
const result = spawnSync(skarbiec, ['list', '--output', 'json'], {
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 4 * 1024 * 1024,
});
if (result.status !== 0) {
  throw new Error(`Skarbiec list failed with exit ${result.status}: ${(result.stderr || '').trim()}`);
}
const payload = JSON.parse(result.stdout);
const tokensResult = spawnSync(skarbiec, ['tokens'], {
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 4 * 1024 * 1024,
});
if (tokensResult.status !== 0) {
  throw new Error(`Skarbiec tokens failed with exit ${tokensResult.status}: ${(tokensResult.stderr || '').trim()}`);
}
const tokens = JSON.parse(tokensResult.stdout);
const itemIds = Array.isArray(payload)
  ? payload.map((entry) => entry?.id).filter((id) => typeof id === 'string').sort()
  : [];
const auditResult = spawnSync(skarbiec, ['audit-query'], {
  encoding: 'utf8',
  env: process.env,
  maxBuffer: 8 * 1024 * 1024,
});
if (auditResult.status !== 0) {
  throw new Error(`Skarbiec audit-query failed with exit ${auditResult.status}`);
}
const auditPayload = JSON.parse(auditResult.stdout);
const figmaAudit = Array.isArray(auditPayload?.entries)
  ? auditPayload.entries
    .filter((entry) => /figma/i.test(JSON.stringify(entry)))
    .slice(-20)
  : [];
const writerConsumer = 'weles-figma-personal-access-token-writer';
const writerToken = Array.isArray(tokens)
  ? tokens.find((token) => token && token.consumer === writerConsumer)
  : null;
const comparableWriters = Array.isArray(tokens)
  ? tokens
    .filter((token) => token && typeof token.consumer === 'string'
      && (token.consumer.includes('figma')
        || token.consumer.includes('supabase-personal-access-token-writer')
        || token.consumer.includes('github-admin-org-token-writer')))
    .map((token) => ({
      consumer: token.consumer,
      state: token.state || null,
      capabilities: Array.isArray(token.capabilities) ? token.capabilities : [],
    }))
  : [];
const target = 'weles-figma-personal-access-token';
const seen = new Set();
function findItem(value) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (!Array.isArray(value) && (value.id === target || value.item === target)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const match = findItem(child);
    if (match) return match;
  }
  return null;
}
function findItemById(value, id, visited = new Set()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return null;
  visited.add(value);
  if (!Array.isArray(value) && (value.id === id || value.item === id)) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const match = findItemById(child, id, visited);
    if (match) return match;
  }
  return null;
}
const item = findItem(payload);
const fields = item && item.fields && typeof item.fields === 'object' && !Array.isArray(item.fields)
  ? Object.keys(item.fields).sort()
  : [];
const comparableItem = findItemById(payload, 'weles-microsoft-primary-password');
const comparableItemMetadata = comparableItem ? {
  keys: Object.keys(comparableItem).sort(),
  kind: comparableItem.kind || null,
  state: comparableItem.state || null,
  controller: comparableItem.controller || comparableItem.writer || comparableItem.owner || null,
  contextKeys: comparableItem.context && typeof comparableItem.context === 'object'
    ? Object.keys(comparableItem.context).sort()
    : [],
} : null;
console.log(JSON.stringify({
  item: target,
  exists: Boolean(item),
  fields,
  itemIds,
  writerConsumer,
  writerTokenPresent: Boolean(writerToken),
  writerTokenState: writerToken?.state || null,
  endpoint: process.env.WC_SKARBIEC_URL || null,
  figmaAudit,
  comparableItemMetadata,
  comparableWriters,
}));
