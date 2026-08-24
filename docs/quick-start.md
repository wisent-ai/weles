# Quick start

How do you go from a source checkout to one verified page load? This page is
the local path: build the CLI, install the exact verified browser release,
open one page, and walk the first-use journey. Submitting real workflows to an
operated deployment goes through the public client instead; that path is at
the end.

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

```bash
node dist/cli.js doctor
```

`doctor` prints a JSON report: package version, Node version, the registered
`bin` map, and whether `CHROMIUM_PATH` and `WELES_USE_STOCK_CHROMIUM` are set
in the environment.

## Install the exact browser release

Weles launches only a checksum-verified, deployment-selected browser build.
`AsyncNewBrowser` resolves the binary through the local install receipt and
throws `WELES_CHROMIUM_BINARY_NOT_FOUND: install the configured immutable
Stado release` when it is absent — there is no fallback to a system Chrome
(`src/async_api.ts`, `src/session/find_browser.ts`).

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

## Open one page

```bash
weles open https://example.com --headless --text
```

The CLI launches the verified browser with a generated fingerprint, navigates
with `domcontentloaded`, and prints JSON: final `url`, `title`, HTTP `status`,
and the body `text`. `--screenshot <file>` saves a full-page capture;
`weles screenshot <url> <file>` is the shorthand. All launch diagnostics go to
stderr so stdout stays parseable.

## Walk the first-use journey

```bash
weles onboarding status
weles onboarding next --subject <stable-id>
```

The journey has three required screens — `authorization-boundary`,
`host-execution`, and `receipt-verification` — and advances durably per
subject. It deliberately launches no browser automation. The final step
accepts only cryptographic proof:

```bash
weles onboarding verify --receipt <receipt.json> --keys <receipt-keys.json>
```

`verify` loads the terminal service receipt and a JSON map of trusted key IDs
to PEM public keys, verifies it through `@wisent-ai/weles-client`, and
completes first use only when the signed outcome is `completed`
(`src/onboarding.ts`). Producing that receipt requires a real workflow on an
operated deployment — see below and [receipts](receipts.md).

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
[authorization](authorization.md); what the worker then does with the row is
in [workflows](workflows.md); the full command surface is in [cli](cli.md).
