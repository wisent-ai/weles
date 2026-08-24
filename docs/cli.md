# CLI reference

What can you run from the `weles` binary? The CLI (`dist/cli.js`, source
`src/cli.ts`) is the local command surface: it drives the verified browser
directly, walks first-use onboarding, and serves the MCP tool set. It is not
the workflow submission path — real tasks enter through
[`@wisent-ai/weles-client`](authorization.md).

## Commands

```text
weles onboarding [status|next|verify|reset] [--subject <stable-id>]
weles onboarding verify --receipt <receipt.json> --keys <receipt-keys.json> [--subject <stable-id>]
weles open <url> [--headless] [--browser chromium|firefox] [--wait-for-text <text>] [--text] [--screenshot <file>] [--timeout <ms>]
weles screenshot <url> <file> [--headless] [--browser chromium|firefox] [--wait-for-text <text>] [--timeout <ms>]
weles mcp
weles doctor
weles version
```

No command, `help`, `-h`, or `--help` prints this usage; `version`, `-v`, or
`--version` prints the package version (`0.5.21` at the revision this page was
executed against). Any other first word fails with `unknown command: <word>`
(`normalizeCommand`, `src/cli.ts`).

### Argument parsing

`parseCliArgs` (`src/cli.ts`) applies three rules worth knowing:

- `--key=value` always assigns the value. Without `=`, only the options listed
  in `optionTakesValue` consume the next argument: `browser`, `os`, `locale`,
  `chromium-path`, `user-data-dir`, `proxy`, `screenshot`, `wait-for-text`,
  `timeout`, `subject`, `receipt`, `keys`, `state-dir`. Everything else
  (`--headless`, `--text`) is a boolean flag.
- Unrecognized `--options` are silently parsed as boolean flags, not rejected.
- Non-`--` words after the command are positionals (`<url>`, `<file>`, the
  onboarding action).

### `weles open <url>`

Launches a browser context through `AsyncNewBrowser`, navigates with
`domcontentloaded`, and prints one pretty-printed JSON object to stdout: `ok`,
final `url`, `title`, and HTTP `status` (`null` when there is no response).
With `--wait-for-text <text>` it first waits for matching visible text;
`--text` adds the body's inner text (empty string on read failure);
`--screenshot <file>` saves a full-page PNG and records the path. Console
diagnostics are rerouted to stderr for the whole run so stdout stays
parseable. The browser must be the installed verified release; on a checkout
without one the launch fails before any navigation:

```console
$ node dist/cli.js open https://example.com --headless --text
[async_api] honest-host: Apple M2 Max / 12c / 32GB / macOS 26.4.1
weles: WELES_CHROMIUM_BINARY_NOT_FOUND: install the configured immutable Stado release
$ echo $?
1
```

Installing the pinned release is covered in the
[quick start](quick-start.md) and [releases](releases.md). A non-numeric or
non-positive `--timeout` throws `invalid --timeout: <value>` (`parseTimeout`,
`src/cli.ts`); it is checked at navigation time, after the launch succeeds.

### `weles screenshot <url> <file>`

Shorthand for `open` with `--screenshot <file>`; accepts the same launch and
wait options and prints the same JSON object (`runScreenshot`, `src/cli.ts`).

### `weles onboarding [status|next|verify|reset]`

Durable first-use journey (product `weles`, journey `first-use`, version
`2026-08-04.1`). The action defaults to `status`, which renders the current
screen; `next` advances a non-terminal screen; `reset` starts over; `verify`
is the only way to complete the final `receipt-verification` screen. Progress
is stored per subject under a durable state directory. The subject defaults to
`WELES_ONBOARDING_SUBJECT` or `<username>@<hostname>` and must be 1 to 512
characters; the state directory defaults to `WELES_ONBOARDING_STATE_DIR` or
`~/.weles/onboarding` (`stableSubject`, `stateDirectory`,
`src/onboarding.ts`). The journey definition is bundled at
`src/onboarding/journeys/` and identity-checked at load; when
`STADO_INTEGRATION_API_URL` and `WELES_STADO_INTEGRATION_TOKEN` are set and
the Stado control plane answers, the view reports `control_plane:
"connected"`, otherwise the bundled definition serves `"offline"` (see
[configuration](configuration.md)).

Every action prints one JSON view: `product_id`, `journey_id`,
`journey_version`, `status`, `attempt_id`, the current `screen`
(`id`, `title`, `body`, `actions`), and `control_plane`. A fresh subject
starts here (captured with `--state-dir $(mktemp -d) --subject docs-demo`):

```console
$ node dist/cli.js onboarding status --state-dir $(mktemp -d) --subject docs-demo
{
  "product_id": "weles",
  "journey_id": "first-use",
  "journey_version": "2026-08-04.1",
  "status": "in_progress",
  "attempt_id": "367ccf43-c753-48b5-ab90-4e33565774a2",
  "screen": {
    "id": "authorization-boundary",
    "title": "Confirm the authorization boundary",
    ...
    "actions": ["next"]
  },
  "control_plane": "offline"
}
```

`next` moves `authorization-boundary` → `host-execution` →
`receipt-verification`; the screen `actions` array then switches from
`["next"]` to `["verify"]`, and a third `next` refuses.

`verify` requires `--receipt <file>` (the terminal service receipt JSON,
either the receipt document itself or an envelope with a `receipt` field) and
`--keys <file>` (a non-empty JSON map of key IDs to PEM public keys). The
receipt is verified through `@wisent-ai/weles-client`; completion additionally
requires the signed `outcome` to be `completed`. On success the view includes
`verified_receipt` with `task_id`, `outcome`, `evidence_digest`, and `key_id`,
and a completed journey renders with an empty `actions` array. See
[receipts](receipts.md) and the
[receipt-verification walkthrough](walkthrough-receipt-verification.md).

### `weles mcp`

Serves the Model Context Protocol over stdio (also installed as the
`weles-mcp` binary, `dist/mcp.js`). The transport is newline-delimited
JSON-RPC 2.0 on stdin/stdout; `console.log` diagnostics are rerouted to
stderr while the server is active. `initialize` answers with
`protocolVersion: "2024-11-05"` and `serverInfo: { name: "weles", version:
<package version> }`; the server also handles `ping`, `tools/list`, and
`tools/call` (`src/mcp.ts`). Unparseable lines get error `-32700 parse
error`, unknown methods `-32601 method not found: <method>`, and tool
failures `-32000` with the thrown message (for example
`unknown browserId: <id>`, `unknown pageId: <id>`, `unknown tool: <name>`).

Tools (`welesMcpTools`, `src/mcp.ts`):

| Tool | Purpose |
|---|---|
| `weles_browser_start` | Launch a browser context via `AsyncNewBrowser`, returns a `browserId` |
| `weles_browser_close` | Close a context and all tracked pages |
| `weles_page_new` | New page in a context, returns a `pageId` |
| `weles_page_goto` | Navigate a tracked page (`waitUntil` defaults to `domcontentloaded`) |
| `weles_page_text` | Read visible text from a page or selector (default `body`, 5000 ms timeout) |
| `weles_page_click` | Click a CSS selector |
| `weles_page_fill` | Fill a CSS selector |
| `weles_page_screenshot` | Capture a screenshot (file path when `path` given, otherwise base64 PNG) |
| `weles_page_evaluate` | Evaluate a JavaScript expression in the page, return the JSON-serializable result |

`weles_browser_start` launches the same verified release as `open`, so it
fails identically on a host without one.

### `weles doctor`

Prints a JSON environment report. Executed output on a source checkout:

```console
$ node dist/cli.js doctor
{
  "ok": true,
  "version": "0.5.21",
  "node": "v22.20.0",
  "bin": {
    "weles": "dist/cli.js",
    "weles-mcp": "dist/mcp.js"
  },
  "env": {
    "CHROMIUM_PATH": "unset",
    "WELES_USE_STOCK_CHROMIUM": "unset"
  }
}
```

`version` and `bin` come from `package.json` (`null` if it cannot be read);
the two `env` entries report only `set`/`unset`, never values (`runDoctor`,
`src/cli.ts`).

### `weles version`

Prints the package version, or `unknown` when `package.json` is unreadable.

## Options

| Option | Takes value | Meaning |
|---|---|---|
| `--subject <stable-id>` | yes | Stable operator/device scope for durable onboarding progress |
| `--receipt <file>` | yes | Real terminal Weles service receipt JSON to verify |
| `--keys <file>` | yes | JSON map of trusted receipt key IDs to PEM public keys |
| `--state-dir <dir>` | yes | Override the durable onboarding state directory |
| `--headless` | no | Launch without a visible browser window |
| `--browser <name>` | yes | Browser engine passed to `AsyncNewBrowser` (default: chromium) |
| `--os <name>` | yes | Persona OS passed to `AsyncNewBrowser` (default: macos) |
| `--locale <locale>` | yes | Locale passed to `AsyncNewBrowser` |
| `--chromium-path <path>` | yes | Custom Chromium binary path option; the launch still resolves only the verified release (`findCustomBrowser`, `src/session/find_browser.ts`) |
| `--user-data-dir <dir>` | yes | Browser profile directory |
| `--proxy <url>` | yes | Proxy server URL |
| `--text` | no | Print document body text after navigation |
| `--screenshot <file>` | yes | Save a screenshot after navigation |
| `--wait-for-text <text>` | yes | Wait for matching visible text before reading or capturing |
| `--timeout <ms>` | yes | Navigation timeout in milliseconds |

## Errors and exit codes

Every failure prints one `weles: <message>` line to stderr and exits with
code 1 (`runCli` catch handler, `src/cli.ts`). Exact strings, all captured by
running the failing command except where a source file is cited:

| Trigger | Message |
|---|---|
| Unknown command | `unknown command: <word>` |
| `open` without a URL | `open requires <url>` |
| `screenshot` missing arguments | `screenshot requires <url> <file>` |
| Verified browser release absent | `WELES_CHROMIUM_BINARY_NOT_FOUND: install the configured immutable Stado release` |
| Invalid `--timeout` | `invalid --timeout: <value>` (`parseTimeout`, `src/cli.ts`) |
| Invalid onboarding action | `onboarding action must be status, next, verify, or reset` |
| `verify` without both flags | `onboarding verify requires --receipt <file> and --keys <file>` |
| Unreadable receipt or keys file | `cannot read workflow receipt: <cause>` / `cannot read receipt key map: <cause>` |
| Keys file is not an object | `receipt key map must be a JSON object` |
| Keys file is `{}` | `receipt key map must not be empty` |
| Empty key ID or non-string PEM | `receipt key map must contain non-empty key IDs and PEM public keys` |
| `verify` before the final screen | `complete the authorization-boundary and host-execution steps before verifying a receipt` |
| `next` on the final screen | `the receipt-verification step requires a signed service receipt; use onboarding verify` |
| Subject empty or over 512 chars | `onboarding subject must contain 1 to 512 characters` (`src/onboarding.ts`) |
| Receipt outcome not `completed` | `verified receipt outcome is not a completed Weles workflow: <outcome>` (`src/onboarding.ts`) |
