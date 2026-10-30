// Every way a browser session driven through `weles mcp` fails, provoked
// against the real server (the built dist/mcp.js, started as `weles mcp` is)
// over its JSON-RPC stream: one test per declared cause of browser.session
// (src/errors/operations/browser.cjs). Each failure must answer the cause's
// sentence as the JSON-RPC error message, naming what failed, why and what
// was observed, and carry the cause's id and fix as `data`.
//
// The browser is the verified Chromium release this host has selected (the
// test refuses to run without one, naming it); the pages are served by this
// test on loopback, over HTTP and over HTTPS with a self-signed certificate
// it generates with openssl.
//
// Usage: node --test tests/browser/session-failures.mjs
// The report is build/real-tests/browser-session-failures/<uuid>/report.json.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { createRequire } from 'node:module';
import { createServer as createTcpServer } from 'node:net';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { evidenceFor, freePort, root } from '../admission/server.mjs';

const require = createRequire(import.meta.url);
const { SESSION } = require('../../src/errors/operations/browser.cjs');

const evidence = evidenceFor('browser-session-failures');
const { report } = evidence;
report.scope = 'weles mcp session failures, one per declared cause';

/** One `weles mcp` process, answering one request at a time. */
function startMcp(environment = {}) {
  // The window size every launch here opens with, unless a test removes it.
  const env = {
    ...process.env,
    WELES_VIEWPORT: '1280x800',
    WELES_RECORDINGS_ROOT: join(work, 'recordings'),
    // No video: the encoder is a separate install (its own test below).
    WELES_DISABLE_RECORDING: '1',
    ...environment,
  };
  for (const [name, value] of Object.entries(env))
    if (value === undefined) delete env[name];
  const child = spawn(process.execPath, [join(root, 'dist', 'mcp.js')], {
    cwd: root,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  let stderr = '';
  const waiting = new Map();
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = waiting.get(message.id);
      if (resolve) {
        waiting.delete(message.id);
        resolve(message);
      }
    }
  });
  let next = 0;
  return {
    /** Send `line` as written; resolves with the answer of id `id`. */
    raw(line, id) {
      const answered = new Promise((resolve) => waiting.set(id, resolve));
      child.stdin.write(`${line}\n`);
      return answered;
    },
    async request(method, params) {
      next += 1;
      const message = { jsonrpc: '2.0', id: next, method };
      if (params !== undefined) message.params = params;
      const answer = await this.raw(JSON.stringify(message), next);
      report.operations.push({ request: message, answer });
      return answer;
    },
    call(name, args) {
      return this.request('tools/call', { name, arguments: args });
    },
    /** End the server: its browsers die with it. */
    async stop() {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.stdin.end();
      child.kill('SIGTERM');
      await exited;
      return stderr;
    },
  };
}

/** The answer is the declared cause `id`, its message holding every `names`. */
function failed(id, answer, names = []) {
  const cause = SESSION.causes.find((entry) => entry.id === id);
  assert.ok(cause, `browser.session declares ${id}`);
  report.cases.push({ cause: id, answer });
  assert.ok(answer.error, `an error answer: ${JSON.stringify(answer)}`);
  assert.equal(answer.error.data?.cause, id, JSON.stringify(answer.error));
  assert.ok(
    answer.error.message.includes('; observed: '),
    answer.error.message,
  );
  assert.ok(answer.error.data.remedy.length > 0);
  for (const name of names)
    assert.ok(
      answer.error.message.includes(name),
      `${id}: the message names ${name}: ${answer.error.message}`,
    );
}

let mcp;
let browserId;
let pageId;
let site;
let tls;
let sitePort;
let tlsPort;
let resetPort;
let resetServer;
const work = join(evidence.directory, 'work');

before(async () => {
  mkdirSync(work, { recursive: true });
  site = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(
      '<!doctype html><title>t</title><input id="name"><input id="file" type="file">',
    );
  });
  sitePort = await freePort();
  await new Promise((resolve) => site.listen(sitePort, '127.0.0.1', resolve));
  const key = join(work, 'key.pem');
  const certificate = join(work, 'certificate.pem');
  const made = spawnSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=127.0.0.1',
    '-keyout',
    key,
    '-out',
    certificate,
  ]);
  assert.equal(made.status, 0, String(made.stderr));
  tls = createTlsServer(
    { key: readFileSync(key), cert: readFileSync(certificate) },
    (request, response) => response.end('tls'),
  );
  tlsPort = await freePort();
  await new Promise((resolve) => tls.listen(tlsPort, '127.0.0.1', resolve));
  // A server that accepts the connection and closes it without answering.
  resetServer = createTcpServer((socket) => socket.destroy());
  resetPort = await freePort();
  await new Promise((resolve) =>
    resetServer.listen(resetPort, '127.0.0.1', resolve),
  );
  mcp = startMcp();
  const initialized = await mcp.request('initialize', {});
  assert.ok(initialized.result, JSON.stringify(initialized));
  const started = await mcp.call('weles_browser_start', {
    browser: 'chromium',
    os: 'macos',
    headless: true,
  });
  assert.ok(
    started.result,
    `this host has no browser Weles can launch, so the session refusals cannot be provoked: ${JSON.stringify(started.error)}`,
  );
  browserId = JSON.parse(started.result.content[0].text).browserId;
  const opened = await mcp.call('weles_page_new', { browserId });
  assert.ok(opened.result, `a page opens: ${JSON.stringify(opened.error)}`);
  pageId = JSON.parse(opened.result.content[0].text).pageId;
  const loaded = await mcp.call('weles_page_goto', {
    pageId,
    url: `http://127.0.0.1:${sitePort}/`,
  });
  assert.ok(loaded.result, JSON.stringify(loaded.error));
});

after(async () => {
  if (mcp) report.server_stderr = await mcp.stop();
  for (const server of [site, tls, resetServer])
    if (server) await new Promise((resolve) => server.close(resolve));
  evidence.finish();
});

test('a_line_that_is_not_json_is_answered_with_the_parser_reason', async () => {
  const answer = await mcp.raw('{"jsonrpc":', null);
  report.operations.push({ request: '{"jsonrpc":', answer });
  failed('request-not-json', answer, ['JSON']);
});

test('an_unknown_method_names_the_methods_served', async () => {
  failed('method-unknown', await mcp.request('resources/list', {}), [
    'resources/list',
    'tools/call',
  ]);
});

test('a_tool_call_without_params_names_what_it_needs', async () => {
  failed('call-without-params', await mcp.request('tools/call'), [
    'params: none',
  ]);
});

test('an_unknown_tool_names_the_tools_served', async () => {
  failed('tool-unknown', await mcp.call('weles_page_scroll', { pageId }), [
    'weles_page_scroll',
    'weles_page_click',
  ]);
});

test('a_missing_argument_is_named', async () => {
  failed('argument-missing', await mcp.call('weles_page_click', { pageId }), [
    'selector',
    'weles_page_click',
  ]);
});

test('an_argument_of_the_wrong_type_is_named', async () => {
  failed(
    'argument-type',
    await mcp.call('weles_page_viewport', { pageId, width: -5, height: 600 }),
    ['width', '-5', 'a positive number'],
  );
});

test('an_unknown_engine_is_refused_before_launch', async () => {
  failed(
    'browser-engine-unknown',
    await mcp.call('weles_browser_start', { browser: 'webkit', os: 'macos' }),
    ['"webkit"'],
  );
});

test('an_unknown_os_is_refused_before_launch', async () => {
  failed(
    'browser-os-unknown',
    await mcp.call('weles_browser_start', { browser: 'chromium', os: 'beos' }),
    ['"beos"'],
  );
});

test('an_unknown_browser_id_lists_the_open_ones', async () => {
  failed(
    'browser-id-unknown',
    await mcp.call('weles_page_new', { browserId: 'browser-0' }),
    ['browser-0', browserId],
  );
});

test('an_unknown_page_id_lists_the_open_ones', async () => {
  failed(
    'page-id-unknown',
    await mcp.call('weles_page_text', { pageId: 'page-9' }),
    ['page-9', pageId],
  );
});

test('a_host_without_the_browser_release_names_where_it_looked', async () => {
  const empty = join(work, 'no-browser');
  mkdirSync(empty, { recursive: true });
  const other = startMcp({ WELES_CHROMIUM_DIR: empty });
  try {
    await other.request('initialize', {});
    const answer = await other.call('weles_browser_start', {
      browser: 'chromium',
      os: 'macos',
      headless: true,
    });
    report.operations.push({ answer });
    failed('browser-release-missing', answer, [empty, 'chromium']);
  } finally {
    report.cases.push({ release_missing_stderr: await other.stop() });
  }
});

/** The first answer of weles_browser_start on a server started with `environment`. */
async function startOn(environment) {
  const other = startMcp(environment);
  try {
    await other.request('initialize', {});
    return await other.call('weles_browser_start', {
      browser: 'chromium',
      os: 'macos',
      headless: true,
    });
  } finally {
    report.cases.push({ other_server_stderr: await other.stop() });
  }
}

test('a_launch_without_a_window_size_names_the_variable', async () => {
  failed(
    'browser-window-unsized',
    await startOn({ WELES_VIEWPORT: undefined, WELES_HONEST_HOST: '0' }),
    ['WELES_VIEWPORT'],
  );
});

test('a_launch_weles_refuses_quotes_its_reason', async () => {
  // NopeCHA's stock-browser launch is retired; asking for it headed is a
  // launch Weles itself refuses before starting the engine.
  const extension = join(work, 'nopecha');
  mkdirSync(extension, { recursive: true });
  const other = startMcp({
    WELES_NOPECHA_EXT: '1',
    WELES_NOPECHA_EXT_DIR: extension,
  });
  try {
    await other.request('initialize', {});
    const answer = await other.call('weles_browser_start', {
      browser: 'chromium',
      os: 'macos',
      headless: false,
    });
    report.operations.push({ answer });
    failed('browser-launch-refused', answer, ['NopeCha', 'Weles said']);
  } finally {
    report.cases.push({ other_server_stderr: await other.stop() });
  }
});

test('a_profile_path_that_is_a_file_is_named', async () => {
  const file = join(work, 'profile-is-a-file');
  writeFileSync(file, 'x');
  failed(
    'browser-profile-unusable',
    await mcp.call('weles_browser_start', {
      browser: 'chromium',
      os: 'macos',
      headless: true,
      userDataDir: file,
    }),
    [file, 'EEXIST'],
  );
});

test('a_browser_that_exits_at_launch_is_named_with_the_engine_words', async () => {
  // A selected release whose receipt verifies and whose executable exits at
  // once, as a damaged install would. The persona is linux, so the launch
  // does not first measure this macOS host through that executable.
  const release = join(work, 'damaged-release');
  const version = '1.0.0-damaged';
  const digest = 'd'.repeat(64);
  const platform = `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
  const binary = join(
    release,
    version,
    process.platform === 'darwin'
      ? 'Chromium.app/Contents/MacOS/Chromium'
      : 'chromium/chrome',
  );
  mkdirSync(join(binary, '..'), { recursive: true });
  writeFileSync(
    binary,
    '#!/bin/sh\necho "this chromium is damaged" >&2\nexit 1\n',
    {
      mode: 0o755,
    },
  );
  writeFileSync(
    join(release, 'selected'),
    `version=${version}\nsha256=${digest}\n`,
  );
  writeFileSync(
    join(release, version, '.weles-release'),
    `release_uri=stado://releases/weles-chromium/${version}/${platform}/release.tar.gz\narchive_sha256=${digest}\nplatform=${platform}\n`,
  );
  const other = startMcp({ WELES_CHROMIUM_DIR: release });
  try {
    await other.request('initialize', {});
    const answer = await other.call('weles_browser_start', {
      browser: 'chromium',
      os: 'linux',
      headless: true,
    });
    failed('browser-launch-failed', answer, ['this chromium is damaged']);
  } finally {
    report.cases.push({ other_server_stderr: await other.stop() });
  }
});

test('a_recorded_session_without_ffmpeg_names_the_encoder', async () => {
  const empty = join(work, 'no-encoder');
  mkdirSync(empty, { recursive: true });
  const other = startMcp({
    WELES_DISABLE_RECORDING: undefined,
    PLAYWRIGHT_BROWSERS_PATH: empty,
  });
  try {
    await other.request('initialize', {});
    const started = await other.call('weles_browser_start', {
      browser: 'chromium',
      os: 'macos',
      headless: true,
    });
    const answer = started.error
      ? started
      : await other.call('weles_page_new', {
          browserId: JSON.parse(started.result.content[0].text).browserId,
        });
    failed('recording-encoder-missing', answer, ['ffmpeg', empty]);
  } finally {
    report.cases.push({ other_server_stderr: await other.stop() });
  }
});

test('a_storage_file_that_does_not_exist_is_named', async () => {
  const path = join(work, 'absent-state.json');
  failed(
    'storage-file-unreadable',
    await mcp.call('weles_browser_storage', { browserId, path }),
    [path, 'ENOENT'],
  );
});

test('a_storage_file_that_is_not_a_state_is_named', async () => {
  const path = join(work, 'not-a-state.json');
  writeFileSync(path, JSON.stringify({ cookies: [] }));
  failed(
    'storage-file-not-state',
    await mcp.call('weles_browser_storage', { browserId, path }),
    [path, 'cookies'],
  );
});

test('a_url_the_browser_cannot_open_is_refused', async () => {
  failed(
    'navigation-url-invalid',
    await mcp.call('weles_page_goto', { pageId, url: 'not a url' }),
    ['not a url'],
  );
});

test('a_host_without_dns_is_named', async () => {
  failed(
    'navigation-host-unresolved',
    await mcp.call('weles_page_goto', {
      pageId,
      url: 'https://nonexistent-host.invalid/',
    }),
    ['nonexistent-host.invalid', 'ERR_NAME_NOT_RESOLVED'],
  );
});

test('a_closed_port_is_named', async () => {
  const closed = await freePort();
  failed(
    'navigation-connection-refused',
    await mcp.call('weles_page_goto', {
      pageId,
      url: `http://127.0.0.1:${closed}/`,
    }),
    [`127.0.0.1:${closed}`, 'ERR_CONNECTION_REFUSED'],
  );
});

test('a_self_signed_certificate_is_named', async () => {
  failed(
    'navigation-certificate-refused',
    await mcp.call('weles_page_goto', {
      pageId,
      url: `https://127.0.0.1:${tlsPort}/`,
    }),
    ['ERR_CERT'],
  );
});

test('a_server_that_closes_the_connection_is_named', async () => {
  failed(
    'navigation-network-failed',
    await mcp.call('weles_page_goto', {
      pageId,
      url: `http://127.0.0.1:${resetPort}/`,
    }),
    ['net::ERR_'],
  );
  // The page goes back to the served document for the tests that follow.
  await mcp.call('weles_page_goto', {
    pageId,
    url: `http://127.0.0.1:${sitePort}/`,
  });
});

test('a_selector_the_engine_cannot_parse_is_named', async () => {
  failed(
    'selector-invalid',
    await mcp.call('weles_page_query', { pageId, selector: 'div[[' }),
    ['weles_page_query', 'div[['],
  );
});

test('an_expression_that_throws_is_answered_with_the_page_error', async () => {
  failed(
    'page-script-threw',
    await mcp.call('weles_page_evaluate', {
      pageId,
      expression: "(() => { throw new Error('page says no') })()",
    }),
    ['page says no'],
  );
});

test('an_upload_of_a_missing_file_is_named', async () => {
  const path = join(work, 'absent-upload.txt');
  failed(
    'upload-file-missing',
    await mcp.call('weles_page_upload', {
      pageId,
      selector: '#file',
      files: [path],
    }),
    [path],
  );
});

test('an_in_page_request_to_a_closed_port_is_named', async () => {
  const closed = await freePort();
  failed(
    'page-request-failed',
    await mcp.call('weles_page_request', {
      pageId,
      url: `http://127.0.0.1:${closed}/`,
    }),
    [`127.0.0.1:${closed}`, 'ECONNREFUSED'],
  );
});

test('an_engine_refusal_is_quoted_whole', async () => {
  // A key the engine has no name for: it refuses at once and says which.
  failed(
    'engine-refused',
    await mcp.call('weles_page_press', {
      pageId,
      selector: '#name',
      key: 'NotAKey',
    }),
    ['weles_page_press', 'NotAKey'],
  );
});

test('a_page_whose_browser_closed_is_named', async () => {
  // A second browser on a profile of its own, whose processes are then
  // killed as a crash would end them.
  const profile = join(work, 'crashing-profile');
  const started = await mcp.call('weles_browser_start', {
    browser: 'chromium',
    os: 'macos',
    headless: true,
    userDataDir: profile,
  });
  assert.ok(started.result, JSON.stringify(started.error));
  const otherBrowser = JSON.parse(started.result.content[0].text).browserId;
  const opened = await mcp.call('weles_page_new', { browserId: otherBrowser });
  const otherPage = JSON.parse(opened.result.content[0].text).pageId;
  const killed = spawnSync('pkill', ['-KILL', '-f', profile]);
  report.cases.push({ pkill_status: killed.status });
  assert.equal(killed.status, 0, 'the browser on that profile was running');
  await new Promise((resolve) => setTimeout(resolve, 500));
  const answer = await mcp.call('weles_page_text', { pageId: otherPage });
  failed('browser-closed', answer, ['weles_page_text', 'closed']);
});
