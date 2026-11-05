// Real Skarbiec, real `weles-mcp` (dist/mcp.js) and a real headless browser:
// `weles_page_fill_secret` types one field of a vault item into a page field,
// and the value never appears in the call, the answer or the server's output.
//
// - a login item's password, read by Weles from the journey's own vault, is
//   the value the page's field holds afterwards, while the JSON-RPC answer and
//   every line the server printed hold no trace of it;
// - an item the vault does not hold is refused naming the item and the
//   commands that find and check it;
// - a field the item does not hold is refused naming the fields it does hold,
//   never their values.
//
// Run after building Weles: node tests/runs/mcp-secret-fill.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { evidenceFor } from '../security/evidence.mjs';
import { activeSkarbiecBinary } from '../../src/_shared/skarbiec-runtime.mjs';

const evidence = await evidenceFor('mcp-secret-fill');
const { report } = evidence;
const root = fileURLToPath(new URL('../../', import.meta.url));
let failure;
let initialized = false;
let server;

try {
  const directory = join(root, 'build/real-tests/mcp-secret-fill', randomUUID());
  const gnupg = join(directory, 'gnupg');
  mkdirSync(gnupg, { recursive: true, mode: constants.S_IRWXU });
  const env = {
    ...process.env,
    GNUPGHOME: gnupg,
    SKARBIEC_VAULT_FILE: join(directory, 'vault.json'),
    WELES_RECORDINGS_ROOT: join(directory, 'recordings'),
    WELES_VIEWPORT: '1280x800',
  };
  const skarbiec = activeSkarbiecBinary();
  const vault = (args, input) => {
    const result = spawnSync(skarbiec, args, { encoding: 'utf8', env, input });
    report.operations.push({ command: [skarbiec, ...args], exit_status: result.status, stderr: result.stderr });
    assert.ok(!result.status && !result.signal, result.stderr);
  };
  vault(['init', 'Weles MCP secret fill test']);
  initialized = true;
  const item = `weles-mcp-secret-fill-${randomUUID()}`;
  const secret = `pw-${randomUUID()}`;
  vault(['set', item], JSON.stringify({ schema: 'skarbiec.item.v2', kind: 'login', context: {}, fields: { username: 'journey@example.com', password: secret } }));

  server = spawn(process.execPath, [join(root, 'dist/mcp.js')], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const printed = [];
  const answers = new Map();
  const waiting = new Map();
  createInterface({ input: server.stdout }).on('line', (line) => {
    printed.push(line);
    const message = JSON.parse(line);
    answers.set(message.id, message);
    waiting.get(message.id)?.(message);
  });
  createInterface({ input: server.stderr }).on('line', (line) => printed.push(line));
  let next = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = ++next;
      waiting.set(id, resolve);
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const tool = async (name, args) => {
    const answer = await call('tools/call', { name, arguments: args });
    report.operations.push({ tool: name, arguments: args, answer });
    return answer;
  };
  const value = (answer) => JSON.parse(answer.result.content[0].text);

  await call('initialize', {});
  const { browserId } = value(await tool('weles_browser_start', { headless: true, browser: 'chromium', os: 'macos' }));
  const { pageId } = value(await tool('weles_page_new', { browserId }));
  await tool('weles_page_goto', { pageId, url: 'data:text/html,<input id="secret" type="password">' });

  const filled = await tool('weles_page_fill_secret', { pageId, selector: '#secret', item, field: 'password' });
  assert.deepEqual(value(filled), { filled: '#secret', item, field: 'password' });
  const held = await tool('weles_page_evaluate', { pageId, expression: `document.getElementById('secret').value === ${JSON.stringify(secret)}` });
  assert.equal(value(held), true, 'the field holds the vault value');

  const missing = await tool('weles_page_fill_secret', { pageId, selector: '#secret', item: `${item}-absent`, field: 'password' });
  assert.match(missing.error.message, new RegExp(`Skarbiec item ${item}-absent could not be read`));
  assert.match(missing.error.message, /skarbiec list --match/);

  const noField = await tool('weles_page_fill_secret', { pageId, selector: '#secret', item, field: 'totp_secret' });
  assert.match(noField.error.message, /holds no text in field totp_secret; it holds password, username/);

  await tool('weles_browser_close', { browserId });
  const leaked = printed.filter((line) => line.includes(secret)).length;
  report.operations.push({ server_lines: printed.length, lines_holding_the_value: leaked });
  assert.equal(leaked, 0, 'no answer or log line holds the vault value');
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = initialized ? 'failed' : 'blocked';
  report.error = { name: error.name, message: error.message, stack: error.stack };
} finally {
  server?.kill();
  await evidence.finish();
}
if (failure) throw failure;
