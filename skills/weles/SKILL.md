---
name: weles
description: Use Weles anti-detect browser automation through its TypeScript API, CLI, or MCP server. Use when a task needs Weles browser launch, fingerprinted Playwright contexts, custom Chromium/Firefox binaries, page navigation, screenshots, DOM text extraction, or an MCP-exposed browser tool surface.
---

# Weles

Weles is the TypeScript browser-automation package in this repo. It exposes the canonical API from `src/index.ts`; do not invent a parallel launcher.

## Canonical API

Use these exports as the source of truth:

- `AsyncNewBrowser(options)` — returns a Playwright `BrowserContext` with Weles fingerprinting, binary selection, diagnostics, proxy handling, and init scripts applied.
- `AsyncWeles` — small lifecycle wrapper around `AsyncNewBrowser`.
- `WSession` — session/trajectory-oriented browser wrapper used by production flows.
- `CDPWeles` / `cdpNewBrowser` — lower-level CDP browser path.

Prefer `AsyncNewBrowser` for one-off browser contexts and MCP/CLI wrappers. Prefer `WSession` only when the task needs the session/trajectory machinery already built around it.

## CLI

After `npm run build`, the package exposes:

```bash
weles open <url> [--headless] [--browser chromium|firefox] [--text] [--screenshot <file>]
weles screenshot <url> <file> [--headless] [--browser chromium|firefox]
weles mcp
weles doctor
```

The CLI is intentionally thin: it maps flags to `AsyncNewBrowserOptions`, performs the requested page action, prints machine-readable JSON for browser actions, and closes the context.

## MCP

Run the stdio server with:

```bash
weles-mcp
# or
weles mcp
```

The MCP server writes protocol frames only to stdout and routes Weles diagnostics to stderr. Exposed tools:

- `weles_browser_start`
- `weles_browser_close`
- `weles_page_new`
- `weles_page_goto`
- `weles_page_text`
- `weles_page_click`
- `weles_page_fill`
- `weles_page_screenshot`
- `weles_page_evaluate`

Always close browser contexts with `weles_browser_close` when a workflow finishes.

## Operational rules

- Build first when using package bins: `npm run build`.
- Use `CHROMIUM_PATH` or `--chromium-path` for a custom Weles Chromium binary unless the environment intentionally uses stock Playwright Chromium.
- Keep CLI/MCP stdout clean. Do not add `console.log` paths to MCP handling or JSON-producing CLI actions; diagnostics belong on stderr.
- For trajectory debugging, use the existing keeper workflow in `AGENTS.md` instead of repeatedly rerunning failing one-shot trajectories.
