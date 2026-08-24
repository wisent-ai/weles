# Quick start

How do you go from a source checkout to one verified page load? This page is
the local path: build the CLI, install the exact verified browser release,
open one page, and walk the first-use journey. Every pasted block below was
executed against a checkout of `weles` 0.5.21 on Node v22.20.0. Submitting
real workflows to an operated deployment goes through the public client
instead; that path is at the end.

## Build from source

```bash
git clone https://github.com/wisent-ai/weles.git
cd weles
npm install
npm run build
```

`npm run build` compiles TypeScript into `dist/`; the `weles` and `weles-mcp`
binaries in `package.json` point at `dist/cli.js` and `dist/mcp.js`. Check the
result:

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

The two `env` entries report only whether the variables are set, never their
values (`runDoctor`, `src/cli.ts`).

## Open one page — and hit the release gate

A fresh checkout has no browser, and Weles launches only a checksum-verified,
deployment-selected build. This is what the first `open` actually does:

```console
$ node dist/cli.js open https://example.com --headless --text
[async_api] honest-host: Apple M2 Max / 12c / 32GB / macOS 26.4.1
weles: WELES_CHROMIUM_BINARY_NOT_FOUND: install the configured immutable Stado release
$ echo $?
1
```

The launch fails before any navigation — `example.com` is never fetched.
There is no fallback to a system Chrome (`src/async_api.ts`,
`src/session/find_browser.ts`); the fix is installing the pinned browser
release for your deployment, as published per [releases](releases.md).

## Install the exact browser release

Set the nonsecret release coordinates and run the installer:

```bash
export STADO_RELEASE_API_URL=<your-release-origin>   # or STADO_RELEASE_LOCAL_ROOT=<dir>
export WELES_CHROMIUM_RELEASE_VERSION=<exact-version>
export WELES_CHROMIUM_RELEASE_SHA256=<exact-archive-sha256>
./scripts/chromium/download.sh
```

The script fetches
`stado://releases/weles-chromium/<version>/<platform>/weles-chromium.tar.gz`,
verifies the archive's SHA-256 against the configured digest, extracts to
`~/.local/share/weles-chromium/<version>/` (override the root with
`WELES_CHROMIUM_DIR`), and writes a `.weles-release` receipt recording the
release URI, digest, and platform. At launch, `findCustomBrowser` re-reads
that receipt and refuses the binary unless it matches the configured
coordinate byte for byte. `scripts/firefox/download.sh` does the same for
Firefox with `WELES_FIREFOX_RELEASE_VERSION` and
`WELES_FIREFOX_RELEASE_SHA256`. A checkout has no browser release until an
operator publishes one; the coordinates come from your deployment.

With the release installed, the same `open` command launches the verified
browser with a generated fingerprint, navigates with `domcontentloaded`, and
prints JSON: `ok`, final `url`, `title`, HTTP `status`, and the body `text`
(`runOpen`, `src/cli.ts`). `--screenshot <file>` saves a full-page capture;
`weles screenshot <url> <file>` is the shorthand. All launch diagnostics go
to stderr so stdout stays parseable.

## Walk the first-use journey

The journey works with or without a browser release — it deliberately
launches no browser automation. First screen on a fresh subject:

```console
$ node dist/cli.js onboarding status --subject docs-demo
{
  "product_id": "weles",
  "journey_id": "first-use",
  "journey_version": "2026-08-04.1",
  "status": "in_progress",
  "attempt_id": "367ccf43-c753-48b5-ab90-4e33565774a2",
  "screen": {
    "id": "authorization-boundary",
    "title": "Confirm the authorization boundary",
    "body": "Weles executes only an already-authorized, allowlisted workflow. Possessing credentials does not authorize a new origin or action; ...",
    "actions": ["next"]
  },
  "control_plane": "offline"
}
```

`onboarding next` advances durably per subject through the three required
screens — `authorization-boundary`, `host-execution`, and
`receipt-verification`. The final step accepts only cryptographic proof; a
third `next` refuses with `the receipt-verification step requires a signed
service receipt; use onboarding verify`:

```bash
node dist/cli.js onboarding verify --receipt <receipt.json> --keys <receipt-keys.json>
```

`verify` loads the terminal service receipt and a JSON map of trusted key IDs
to PEM public keys, verifies it through `@wisent-ai/weles-client`, and
completes first use only when the signed outcome is `completed`
(`src/onboarding.ts`). Producing that receipt requires a real workflow on an
operated deployment — see below, [receipts](receipts.md), and the full
[CLI reference](cli.md) for every flag and exact error string.

## Submit a real workflow

An approved deployment provides its endpoint, organization ID, and
organization-scoped token (README):

```sh
export WELES_API_BASE=<deployment-endpoint>
export WISENT_ORGANIZATION_ID=<organization-uuid>
export WELES_TOKEN=<organization-scoped-token>
```

From there, agents submit through the public
[`@wisent-ai/weles-client`](https://github.com/wisent-ai/weles-client) with
exact origin/action allowlists, credential references, a justification, and an
idempotency key. The submission contract is in
[authorization](authorization.md); how the admitted task is executed is in
[workflows](workflows.md); the full command surface is in [cli](cli.md).
