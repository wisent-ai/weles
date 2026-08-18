#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const path = `${process.env.HOME}/.stado/weles-figma-ui-inventory.log`;
const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
const payload = JSON.parse(lines.at(-1));
const files = (payload.companyFiles || []).map((file) => {
  const match = file.url?.match(/figma\.com\/(design|file|board|slides|make|proto)\/([^/?]+)/i);
  return {
    name: file.name,
    type: match?.[1] || null,
    key: match?.[2] || null,
    error: file.error || null,
  };
});
for (const file of files.slice(7)) console.log(JSON.stringify(file));
