# Weles Custom Chromium

Weles runs only the deployment-selected patched Chromium release. Browser
discovery does not search for a newest install, a local build, a stock browser,
or a Playwright cache fallback.

## Immutable release contract

Before installation, set these nonsecret coordinates in the deployment env:

```bash
STADO_RELEASE_API_URL=
WELES_CHROMIUM_RELEASE_VERSION=
WELES_CHROMIUM_RELEASE_SHA256=
```

Do not commit values. The release publisher must upload exactly one archive for
each supported deployment platform:

```text
stado://releases/weles-chromium/<version>/darwin-arm64/weles-chromium.tar.gz
stado://releases/weles-chromium/<version>/darwin-amd64/weles-chromium.tar.gz
stado://releases/weles-chromium/<version>/linux-amd64/weles-chromium.tar.gz
```

The SHA-256 configured for the host is the digest of that exact archive. The
archive layout must contain `Chromium.app/Contents/MacOS/Chromium` on macOS or
`chromium/chrome` on Linux.

```bash
bash scripts/chromium/download.sh
```

The installer reads only the canonical public Stado release endpoint. Missing
coordinates, a missing object, an unsupported platform, a checksum mismatch, or
a missing executable aborts before installation. Extraction happens only after
the configured digest matches. A matching release receipt is written beside
the installation and is required by `findCustomBrowser()` before launch.

`WELES_CHROMIUM_DIR` may override the install root. It does not select a
release and does not bypass the exact version, platform, checksum, or receipt.
`CHROMIUM_PATH`, provider tokens, Git credentials, release tags, and newest
installed-version discovery are not part of the runtime contract.

## Building

The patched source lives in the sibling `chromium-build/src` checkout. A build
may be packaged locally with:

```bash
bash scripts/chromium/build.sh
```

Packaging does not publish or mutate deployment coordinates. An operator must
publish the generated archive at the exact Stado URI above and independently
place its SHA-256 in deployment configuration. Stado release objects are
immutable; publish a new version rather than replacing an existing object.
