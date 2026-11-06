// How a browser session driven through `weles mcp` fails: every cause the
// JSON-RPC server, its arguments, the browser launch and the browser engine
// can meet, declared once. A failure the engine reports in its own words is
// not re-worded: `engineCause` classifies it by what the engine states and
// quotes it as the observed state. A Weles context sets no default timeout
// (browser/launch/chromium.ts), so a wait ends when its state is reached or
// its browser closes, never on a deadline of its own.
'use strict';

const { DeclaredError, declare, messageOf } = require('../index.cjs');

const TEST = 'tests/browser/session-failures.mjs';
const cause = (fields) => declare('browser', fields);
const usage = (fields) => cause({ usage: true, code: 'refused', ...fields });

const REQUEST_NOT_JSON = usage({
  id: 'request-not-json',
  failed: 'reading one request line',
  cause:
    'the line is not a JSON document, so it names no method and no id to answer',
  observed: 'the parser said: {answer}',
  remedy:
    'write one JSON-RPC 2.0 request per line, such as {"jsonrpc":"2.0","id":1,"method":"tools/list"}',
  test: `${TEST}::a_line_that_is_not_json_is_answered_with_the_parser_reason`,
});

const METHOD_UNKNOWN = usage({
  id: 'method-unknown',
  failed: 'answering method {method}',
  cause: 'weles mcp answers only initialize, ping, tools/list and tools/call',
  observed: 'method: {method}',
  remedy: 'send one of initialize, ping, tools/list or tools/call',
  test: `${TEST}::an_unknown_method_names_the_methods_served`,
});

const CALL_WITHOUT_PARAMS = usage({
  id: 'call-without-params',
  failed: 'calling a tool',
  cause: 'tools/call carries no params, so it names no tool',
  observed: 'params: none',
  remedy:
    'send params { "name": "<tool>", "arguments": { ... } }; tools/list names every tool',
  test: `${TEST}::a_tool_call_without_params_names_what_it_needs`,
});

const TOOL_UNKNOWN = usage({
  id: 'tool-unknown',
  failed: 'calling tool {tool}',
  cause: 'weles mcp serves no tool of that name',
  observed: 'tools served: {tools}',
  remedy: 'call one of the tools tools/list answers',
  test: `${TEST}::an_unknown_tool_names_the_tools_served`,
});

const ARGUMENT_MISSING = usage({
  id: 'argument-missing',
  failed: 'reading argument {name} of {tool}',
  cause: '{name} is required and was not given, or was given empty',
  observed: '{name}: {value}',
  remedy: 'give {name} as its schema in tools/list states',
  test: `${TEST}::a_missing_argument_is_named`,
});

const ARGUMENT_TYPE = usage({
  id: 'argument-type',
  failed: 'reading argument {name} of {tool}',
  cause: '{name} must be {expected}',
  observed: '{name}: {value}',
  remedy: 'give {name} as {expected}',
  test: `${TEST}::an_argument_of_the_wrong_type_is_named`,
});

const ENGINE_UNKNOWN = usage({
  id: 'browser-engine-unknown',
  failed: 'starting a browser',
  cause: 'browser names no engine Weles launches',
  observed: 'browser: {value}',
  remedy: 'give browser as chromium or firefox',
  test: `${TEST}::an_unknown_engine_is_refused_before_launch`,
});

const OS_UNKNOWN = usage({
  id: 'browser-os-unknown',
  failed: 'starting a browser',
  cause: 'os names no operating system a Weles persona presents',
  observed: 'os: {value}',
  remedy: 'give os as macos, windows or linux',
  test: `${TEST}::an_unknown_os_is_refused_before_launch`,
});

const BROWSER_ID_UNKNOWN = cause({
  id: 'browser-id-unknown',
  code: 'not_found',
  failed: 'finding browser {id}',
  cause:
    'this server never handed out that browserId, or the browser was closed, or the server restarted since',
  observed: 'browsers open in this server: {open}',
  remedy:
    'start a browser with weles_browser_start and use the browserId it answers',
  test: `${TEST}::an_unknown_browser_id_lists_the_open_ones`,
});

const PAGE_ID_UNKNOWN = cause({
  id: 'page-id-unknown',
  code: 'not_found',
  failed: 'finding page {id}',
  cause:
    'this server never handed out that pageId, or its browser was closed, or the server restarted since',
  observed: 'pages open in this server: {open}',
  remedy: 'open a page with weles_page_new and use the pageId it answers',
  test: `${TEST}::an_unknown_page_id_lists_the_open_ones`,
});

const RELEASE_MISSING = cause({
  id: 'browser-release-missing',
  code: 'config',
  failed: 'finding the {engine} executable',
  cause: 'no verified {engine} release is installed and selected on this host',
  observed: '{answer}',
  remedy:
    'install the selected weles-{engine} release through Stado, or point WELES_{ENGINE}_DIR at a verified install',
  test: `${TEST}::a_host_without_the_browser_release_names_where_it_looked`,
});

const LAUNCH_FAILED = cause({
  id: 'browser-launch-failed',
  code: 'config',
  failed: 'launching {engine}',
  cause:
    'the browser executable started but exited or never opened its control channel: a damaged install, a missing system library, or a sandbox that refuses it',
  observed: 'the engine said: {answer}',
  remedy:
    'run the executable the message names by hand to see why it exits, then reinstall the selected weles-{engine} release through Stado',
  test: `${TEST}::a_browser_that_exits_at_launch_is_named_with_the_engine_words`,
});

const WINDOW_UNSIZED = cause({
  id: 'browser-window-unsized',
  code: 'config',
  failed: 'starting a browser',
  cause:
    'the launch states no window size: WELES_VIEWPORT is unset, no persona was given, and the host screen is not read',
  observed: 'Weles said: {answer}',
  remedy:
    'set WELES_VIEWPORT=<width>x<height> in the environment of weles mcp (1280x800, say), or turn the honest host on so Weles reads the screen',
  test: `${TEST}::a_launch_without_a_window_size_names_the_variable`,
});

const LAUNCH_REFUSED = cause({
  id: 'browser-launch-refused',
  code: 'config',
  failed: 'starting a browser',
  cause:
    "Weles refused the launch before starting the engine: a setting the launch needs is missing or contradicts another, in Weles' own words below",
  observed: 'Weles said: {answer}',
  remedy:
    'set what the sentence names in the environment of weles mcp, then start the browser again',
  test: `${TEST}::a_launch_weles_refuses_quotes_its_reason`,
});

const PROFILE_UNUSABLE = cause({
  id: 'browser-profile-unusable',
  code: 'config',
  failed: 'opening the browser profile {profile}',
  cause:
    'userDataDir cannot hold a profile: a file stands at that path, its parent is not a directory, or the server user may not write there',
  observed: 'Weles said: {answer}',
  remedy:
    'give userDataDir as a directory this server can create and write, or leave it out for a fresh profile',
  test: `${TEST}::a_profile_path_that_is_a_file_is_named`,
});

const RECORDER_MISSING = cause({
  id: 'recording-encoder-missing',
  code: 'config',
  failed: '{tool} in a recorded browser',
  cause:
    'the session records video and the ffmpeg encoder Playwright records with is not installed where PLAYWRIGHT_BROWSERS_PATH points',
  observed: 'the engine said: {answer}',
  remedy:
    'install it with `npx playwright install ffmpeg` (the release ships it under browser-runtime), or start weles mcp with WELES_DISABLE_RECORDING=1',
  test: `${TEST}::a_recorded_session_without_ffmpeg_names_the_encoder`,
});

const STORAGE_UNREADABLE = cause({
  id: 'storage-file-unreadable',
  code: 'not_found',
  failed: 'reading the storage state {path}',
  cause:
    'the file cannot be read: it does not exist, or the server user may not read it',
  observed: '{answer}',
  remedy:
    'give path as a storage-state file this server can read, such as one context.storageState({ path }) wrote',
  test: `${TEST}::a_storage_file_that_does_not_exist_is_named`,
});

const STORAGE_NOT_STATE = cause({
  id: 'storage-file-not-state',
  code: 'refused',
  failed: 'reading the storage state {path}',
  cause:
    'the file is not a Playwright storage state: it is not JSON, or it lacks the cookies and origins arrays',
  observed: '{answer}',
  remedy:
    'give a file of the form { "cookies": [...], "origins": [...] }, as context.storageState() writes it',
  test: `${TEST}::a_storage_file_that_is_not_a_state_is_named`,
});

const NAVIGATION_URL = usage({
  id: 'navigation-url-invalid',
  failed: 'opening {url}',
  cause:
    'the engine cannot navigate to it: it is not an absolute URL with a scheme the browser opens',
  observed: 'the engine said: {answer}',
  remedy: 'give url as an absolute address such as https://example.com/',
  test: `${TEST}::a_url_the_browser_cannot_open_is_refused`,
});

const HOST_UNRESOLVED = cause({
  id: 'navigation-host-unresolved',
  code: 'not_found',
  failed: 'opening {url}',
  cause:
    'the host has no DNS answer: it does not exist, or this machine reaches no resolver (or the proxy the browser uses cannot resolve it)',
  observed: 'the engine said: {answer}',
  remedy:
    "check the host name; if it resolves elsewhere, check this machine's DNS or the proxy given to weles_browser_start",
  test: `${TEST}::a_host_without_dns_is_named`,
});

const CONNECTION_REFUSED = cause({
  id: 'navigation-connection-refused',
  code: 'infra_down',
  failed: 'opening {url}',
  cause:
    'nothing accepts connections at that address and port: the site is down, or a firewall rejects the browser',
  observed: 'the engine said: {answer}',
  remedy:
    'start the service at that address or correct the port, then call again',
  test: `${TEST}::a_closed_port_is_named`,
});

const CERTIFICATE = cause({
  id: 'navigation-certificate-refused',
  code: 'refused',
  failed: 'opening {url}',
  cause:
    "the browser refused the site's TLS certificate: it is self-signed, expired, issued for another host, or signed by an authority the browser does not trust",
  observed: 'the engine said: {answer}',
  remedy:
    'serve the site with a certificate a public authority issued for its host; Weles does not open a page whose certificate it cannot verify',
  test: `${TEST}::a_self_signed_certificate_is_named`,
});

const NETWORK = cause({
  id: 'navigation-network-failed',
  code: 'infra_down',
  failed: 'opening {url}',
  cause:
    'the connection was made but broke before a response: the server closed it, reset it or sent no HTTP answer',
  observed: 'the engine said: {answer}',
  remedy:
    'check the server at that address answers HTTP (curl -v the URL), then call again',
  test: `${TEST}::a_server_that_closes_the_connection_is_named`,
});

const SELECTOR_INVALID = usage({
  id: 'selector-invalid',
  failed: '{tool} on page {page}',
  cause: 'the selector is not one the engine parses',
  observed: 'the engine said: {answer}',
  remedy:
    'give a Playwright selector: CSS, role=button[name="Start"], text=Continue or internal:label="Email"',
  test: `${TEST}::a_selector_the_engine_cannot_parse_is_named`,
});

const SCRIPT_THREW = cause({
  id: 'page-script-threw',
  code: 'refused',
  failed: '{tool} on page {page}',
  cause: 'the expression threw inside the page',
  observed: 'the page said: {answer}',
  remedy:
    'correct the expression; run it in the page console to see the same error',
  test: `${TEST}::an_expression_that_throws_is_answered_with_the_page_error`,
});

const BROWSER_CLOSED = cause({
  id: 'browser-closed',
  code: 'not_found',
  failed: '{tool} on page {page}',
  cause:
    'the page or its browser is gone: it was closed, or the browser process exited or crashed',
  observed: 'the engine said: {answer}',
  remedy:
    'open the browser and page again with weles_browser_start and weles_page_new',
  test: `${TEST}::a_page_whose_browser_closed_is_named`,
});

const FILE_MISSING = cause({
  id: 'upload-file-missing',
  code: 'not_found',
  failed: '{tool} on page {page}',
  cause: 'a file to upload does not exist or cannot be read by the server user',
  observed: 'the engine said: {answer}',
  remedy:
    'give files as absolute paths of readable files on the machine weles mcp runs on',
  test: `${TEST}::an_upload_of_a_missing_file_is_named`,
});

const REQUEST_FAILED = cause({
  id: 'page-request-failed',
  code: 'infra_down',
  failed: 'sending {method} {url} from page {page}',
  cause:
    'the request got no HTTP answer: the host has no DNS answer, nothing listens there, or the connection broke',
  observed: 'the engine said: {answer}',
  remedy: 'check the address answers (curl -v the URL), then call again',
  test: `${TEST}::an_in_page_request_to_a_closed_port_is_named`,
});

const ENGINE_REFUSED = cause({
  id: 'engine-refused',
  code: 'refused',
  failed: '{tool} on page {page}',
  cause:
    'the browser engine refused the operation for a reason Weles does not classify further, stated in its own words below',
  observed: 'the engine said: {answer}',
  remedy:
    "read the engine's words: they name the element, state or value it refused; correct that argument and call again",
  test: `${TEST}::an_engine_refusal_is_quoted_whole`,
});

const SESSION = Object.freeze({
  id: 'browser.session',
  command: 'weles mcp',
  summary:
    'Drive a Weles browser one operation at a time over JSON-RPC: start a browser, open pages in it and navigate, read, act and assert on them by the ids the server hands out.',
  causes: [
    REQUEST_NOT_JSON,
    METHOD_UNKNOWN,
    CALL_WITHOUT_PARAMS,
    TOOL_UNKNOWN,
    ARGUMENT_MISSING,
    ARGUMENT_TYPE,
    ENGINE_UNKNOWN,
    OS_UNKNOWN,
    BROWSER_ID_UNKNOWN,
    PAGE_ID_UNKNOWN,
    RELEASE_MISSING,
    WINDOW_UNSIZED,
    LAUNCH_REFUSED,
    PROFILE_UNUSABLE,
    LAUNCH_FAILED,
    RECORDER_MISSING,
    STORAGE_UNREADABLE,
    STORAGE_NOT_STATE,
    NAVIGATION_URL,
    HOST_UNRESOLVED,
    CONNECTION_REFUSED,
    CERTIFICATE,
    NETWORK,
    SELECTOR_INVALID,
    SCRIPT_THREW,
    BROWSER_CLOSED,
    FILE_MISSING,
    REQUEST_FAILED,
    ENGINE_REFUSED,
  ],
});

/**
 * The declared cause of a failure the browser engine reported, by what it
 * states: Chromium's net::ERR_ names for a navigation, Playwright's own
 * TimeoutError, selector parser, closed-target and missing-file words, and the
 * page's own exception for an evaluation. `values` names the tool and page;
 * the engine's message is the observed state, whole.
 */
function engineCause(error, values) {
  if (error instanceof DeclaredError) return error;
  const answer = messageOf(error);
  const filled = { ...values, answer };
  let declared = ENGINE_REFUSED;
  if (/BINARY_NOT_FOUND/.test(answer)) declared = RELEASE_MISSING;
  else if (/ffmpeg/.test(answer)) declared = RECORDER_MISSING;
  else if (
    values.tool === 'weles_browser_start' &&
    values.profile &&
    /EEXIST|ENOTDIR|EACCES|EPERM|EROFS/.test(answer)
  )
    declared = PROFILE_UNUSABLE;
  else if (/the browser window has no size/.test(answer))
    declared = WINDOW_UNSIZED;
  else if (values.tool === 'weles_browser_start')
    // Playwright names its own launch call; anything else Weles said itself
    // before the engine started.
    declared =
      /browserType\.|launchPersistentContext|Browser closed|Target page, context or browser has been closed|exited/.test(
        answer,
      )
        ? LAUNCH_FAILED
        : LAUNCH_REFUSED;
  else if (/net::ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/.test(answer))
    declared =
      values.tool === 'weles_page_request' ? REQUEST_FAILED : HOST_UNRESOLVED;
  else if (/net::ERR_CONNECTION_REFUSED|ECONNREFUSED/.test(answer))
    declared =
      values.tool === 'weles_page_request'
        ? REQUEST_FAILED
        : CONNECTION_REFUSED;
  else if (/net::ERR_CERT_|ERR_SSL_|SSL_ERROR|SEC_ERROR_/.test(answer))
    declared = CERTIFICATE;
  else if (/net::ERR_|NS_ERROR_|ECONNRESET|socket hang up/.test(answer))
    declared = values.tool === 'weles_page_request' ? REQUEST_FAILED : NETWORK;
  else if (
    /Cannot navigate to invalid URL|invalid URL|Invalid URL/.test(answer)
  )
    declared = NAVIGATION_URL;
  else if (/has been closed|Target closed|Browser closed/.test(answer))
    declared = BROWSER_CLOSED;
  else if (/ENOENT|no such file/.test(answer)) declared = FILE_MISSING;
  else if (
    /Unexpected token|is not a valid selector|Unknown engine|Failed to parse selector/.test(
      answer,
    )
  )
    declared = SELECTOR_INVALID;
  else if (
    /^page\.evaluate|^page\.waitForFunction|^locator\.evaluate/.test(answer)
  )
    declared = SCRIPT_THREW;
  if (values.engine) filled.ENGINE = values.engine.toUpperCase();
  return new DeclaredError(declared, filled, { cause: error });
}

module.exports = {
  SESSION,
  engineCause,
  causes: Object.freeze({
    REQUEST_NOT_JSON,
    METHOD_UNKNOWN,
    CALL_WITHOUT_PARAMS,
    TOOL_UNKNOWN,
    ARGUMENT_MISSING,
    ARGUMENT_TYPE,
    ENGINE_UNKNOWN,
    OS_UNKNOWN,
    BROWSER_ID_UNKNOWN,
    PAGE_ID_UNKNOWN,
    RELEASE_MISSING,
    LAUNCH_FAILED,
    STORAGE_UNREADABLE,
    STORAGE_NOT_STATE,
  }),
};
