// Create a properly-formatted Google Doc via the Drive REST API.
//
// 1. md_to_html.mjs strips validator scaffolding and converts to HTML.
// 2. upload_doc_api.py POSTs the HTML to upload/drive/v3/files with
//    mimeType=application/vnd.google-apps.document so Drive converts
//    HTML->Doc server-side. Result is a native Google Doc with real
//    heading styles, bold, lists, code, links.
// 3. Reads OAuth from growth-tactics/google_drive/token.pickle (the
//    wisent.ai pickle, drive scope, auto-refreshes). See the
//    wisent_ai_oauth_pickle memory entry — never propose a new auth
//    flow when this pickle exists.
//
// Run:
//   node weles/scripts/trajectories/google/drive/paste_doc.mjs \
//     --title "..." --content path/to/file.md
//
// Env mirror: DOC_TITLE, DOC_CONTENT_PATH.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const TITLE = arg('--title') || process.env.DOC_TITLE;
const CONTENT_PATH = arg('--content') || process.env.DOC_CONTENT_PATH;

if (!TITLE) { console.log('FAIL: --title (or DOC_TITLE) required'); process.exit(2); }
if (!CONTENT_PATH) { console.log('FAIL: --content (or DOC_CONTENT_PATH) required'); process.exit(2); }
if (!existsSync(CONTENT_PATH)) { console.log('FAIL: content file not found: ' + CONTENT_PATH); process.exit(2); }

const WELES_ROOT = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/weles';
const MD_TO_HTML = WELES_ROOT + '/scripts/lib/md_to_html.mjs';
const UPLOAD = WELES_ROOT + '/scripts/lib/upload_doc_api.py';
const PYTHON = '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3.12';
const OUT_DIR = '/Users/lukaszbartoszcze/Documents/CodingProjects/Wisent/content-platform/.work/paste_doc';
const HTML_PATH = OUT_DIR + '/last_upload.html';

mkdirSync(OUT_DIR, { recursive: true });

console.log('[paste_doc] md -> html: ' + CONTENT_PATH);
const conv = spawnSync('node', [MD_TO_HTML, CONTENT_PATH, HTML_PATH], { encoding: 'utf8' });
process.stdout.write(conv.stdout || '');
if (conv.status !== 0) {
  console.log('FAIL: md_to_html exit=' + conv.status + ' stderr=' + (conv.stderr || ''));
  process.exit(1);
}

console.log('[paste_doc] upload via Drive API…');
const up = spawnSync(PYTHON, [UPLOAD, HTML_PATH, TITLE], { encoding: 'utf8' });
const stdout = (up.stdout || '').trim();
if (up.status !== 0) {
  console.log('FAIL: upload exit=' + up.status + ' stderr=' + (up.stderr || '').slice(0, 500));
  process.exit(1);
}
console.log('URL: ' + stdout);
console.log('PASS: doc available at ' + stdout);
