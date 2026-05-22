#!/usr/bin/env node
// Convert markdown to HTML for Drive upload-with-convert. Strips the
// validator's <!-- value name="X" --> ... <!-- /value --> scaffolding
// and replaces with "**Answer:** value" lines.
//
// Usage: node md_to_html.mjs <in.md> <out.html>

import { readFileSync, writeFileSync } from 'node:fs';

if (process.argv.length < 4) {
  console.error('usage: md_to_html.mjs <in.md> <out.html>');
  process.exit(2);
}

const md = readFileSync(process.argv[2], 'utf8');

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function cleanContent(s) {
  let out = s.replace(/<!--\s*value\s+name="([^"]+)"[^>]*-->([\s\S]*?)<!--\s*\/value\s*-->/g, (_, _n, body) => {
    const v = body.trim();
    return v ? '**Answer:** ' + v : '**Answer:** _(empty)_';
  });
  return out.replace(/<!--[\s\S]*?-->/g, '');
}

function mdToHtml(input) {
  const lines = input.split('\n');
  const out = []; let inUl = false; let inOl = false; let paraBuf = [];
  const inline = (s) => escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  const flushPara = () => { if (paraBuf.length) { out.push('<p>' + inline(paraBuf.join(' ')) + '</p>'); paraBuf = []; } };
  const closeLists = () => { if (inUl) { out.push('</ul>'); inUl = false; } if (inOl) { out.push('</ol>'); inOl = false; } };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, '');
    if (line === '') { flushPara(); closeLists(); continue; }
    const h = line.match(/^(#{1,4})\s+(.+)$/);
    if (h) { flushPara(); closeLists(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const ul = line.match(/^[-*]\s+(.+)$/);
    if (ul) { flushPara(); if (inOl) { out.push('</ol>'); inOl = false; } if (!inUl) { out.push('<ul>'); inUl = true; } out.push('<li>' + inline(ul[1]) + '</li>'); continue; }
    const ol = line.match(/^\d+\.\s+(.+)$/);
    if (ol) { flushPara(); if (inUl) { out.push('</ul>'); inUl = false; } if (!inOl) { out.push('<ol>'); inOl = true; } out.push('<li>' + inline(ol[1]) + '</li>'); continue; }
    if (line === '---') { flushPara(); closeLists(); out.push('<hr>'); continue; }
    closeLists(); paraBuf.push(line);
  }
  flushPara(); closeLists();
  return '<html><body>' + out.join('\n') + '</body></html>';
}

const html = mdToHtml(cleanContent(md));
writeFileSync(process.argv[3], html);
console.log('html bytes:', html.length, '-> ' + process.argv[3]);
