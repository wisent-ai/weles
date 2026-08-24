# CLI reference

The `weles` binary (`dist/cli.js`, source `src/cli.ts`) is the local command
surface: it drives the verified browser directly, walks first-use onboarding,
and serves the MCP tool set. It is not the workflow submission path — real
tasks enter through [`@wisent-ai/weles-client`](authorization.md).

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

### `weles open <url>`

Launches a browser context through `AsyncNewBrowser`, navigates with
`domcontentloaded`, and prints one JSON object to stdout: `ok`, final `url`,
`title`, and HTTP `status`. With `--wait-for-text <text>` it first waits for
matching visible text; `--text` adds the body's inner text; `--screenshot
<file>` saves a full-page PNG and records the path. Console diagnostics are
rerouted to stderr for the whole run. The browser must be the installed
verified release; otherwise the launch throws
`WELES_CHROMIUM_BINARY_NOT_FOUND` ([quick-start](quick-start.md)).

### `weles screenshot <url> <file>`

Shorthand for `open` with `--screenshot <file>`.

### `weles onboarding [status|next|verify|reset]`

Durable first-use journey (product `weles`, journey `first-use`). `status`
renders the current screen; `next` advances a non-terminal screen; `reset`
starts over; `verify` is the only way to complete the final
`receipt-verification` screen. Progress is stored per `--subject` under a
durable state directory (`--state-dir` overrides it). The journey definition
is bundled at `src/onboarding/journeys/` and identity-checked at load; when
the Stado control plane is reachable the view reports
`control_plane: connected`, otherwise the bundled definition serves offline.

`verify` requires `--receipt <file>` (the terminal service receipt JSON,
either the receipt document itself or an envelope with a `receipt` field) and
`--keys <file>` (a non-empty JSON map of key IDs to PEM public keys). The
receipt is verified through `@wisent-ai/weles-client`; completion additionally
requires the signed `outcome` to be `completed`. On success the view includes
`verified_receipt` with `task_id`, `outcome`, `evidence_digest`, and `key_id`.
See [receipts](receipts.md).

### `weles mcp`

Serves the Model Context Protocol over stdio (also installed as the
`weles-mcp` binary). Stdout carries JSON-RPC only; diagnostics go to stderr.
Tools (`src/mcp.ts`):

| Tool | Purpose |
|---|---|
| `weles_browser_start` | Launch a browser context via `AsyncNewBrowser`, returns a `browserId` |
| `weles_browser_close` | Close a context and all tracked pages |
| `weles_page_new` | New page in a context, returns a `pageId` |
| `weles_page_goto` | Navigate a tracked page |
| `weles_page_text` | Read visible text from a page or selector |
| `weles_page_click` | Click a CSS selector |
| `weles_page_fill` | Fill a CSS selector |
| `weles_page_screenshot` | Capture a screenshot (file path or base64 PNG) |
| `weles_page_evaluate` | Evaluate a JavaScript expression, return the JSON-serializable result |

### `weles doctor`

Prints a JSON environment report: package `version`, `node` version, the
`bin` map, and whether `CHROMIUM_PATH` and `WELES_USE_STOCK_CHROMIUM` are set.

### `weles version`

Prints the package version.

## Options

| Option | Meaning |
|---|---|
| `--subject <stable-id>` | Stable operator/device scope for durable onboarding progress |
| `--receipt <file>` | Real terminal Weles service receipt JSON to verify |
| `--keys <file>` | JSON map of trusted receipt key IDs to PEM public keys |
| `--state-dir <dir>` | Override the durable onboarding state directory |
| `--headless` | Launch without a visible browser window |
| `--browser <name>` | Browser engine passed to `AsyncNewBrowser` (default: chromium) |
| `--os <name>` | Persona OS passed to `AsyncNewBrowser` (default: macos) |
| `--locale <locale>` | Locale passed to `AsyncNewBrowser` |
| `--chromium-path <path>` | Custom Chromium binary path option; the launch still resolves only the verified release |
| `--user-data-dir <dir>` | Browser profile directory |
| `--proxy <url>` | Proxy server URL |
| `--text` | Print document body text after navigation |
| `--screenshot <file>` | Save a screenshot after navigation |
| `--wait-for-text <text>` | Wait for matching visible text before reading or capturing |
| `--timeout <ms>` | Navigation timeout in milliseconds |
