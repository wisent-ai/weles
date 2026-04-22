# Weles Custom Chromium

Weles needs a patched Chromium binary — the fingerprint fixes (canvas noise removal, WebGL renderer, codec shims, ALPS/HTTP2, etc.) live in the C++ source, not just init scripts. Team members should **download the prebuilt binary**, not rebuild from source.

## Download

```bash
bash scripts/chromium/download.sh
```

This:

1. Detects your OS/arch
2. Downloads the matching tarball from GitHub Releases
3. Verifies its SHA256
4. Extracts to `$HOME/.local/share/weles-chromium/<version>/`
5. Prints the resulting binary path

`wsession.ts`'s `findCustomChromium()` picks up the install automatically — no env vars needed.

## Environment variables

- `WELES_CHROMIUM_DIR` — override install root (default `$HOME/.local/share/weles-chromium`)
- `WELES_CHROMIUM_RELEASE` — override release tag (default `chromium-147.0.7727.108-weles.1`)
- `CHROMIUM_PATH` — override the resolved binary path entirely (takes precedence over `findCustomChromium()`)

## Release tag scheme

`chromium-<upstream-version>-weles.<iter>` — e.g. `chromium-147.0.7727.108-weles.1`. Bump `.1 → .2` when the weles patch changes but the upstream Chromium version stays the same; bump the upstream version on a rebase.

## Platforms

| Platform | Asset | Size | Status |
|---|---|---|---|
| macOS arm64 | `weles-chromium-147-macos-arm64.tar.gz` | 170 MB | ✅ published |
| Linux x86_64 | `weles-chromium-147-linux-x86_64.tar.gz` | 193 MB | ✅ published |
| macOS x86_64 | — | — | not planned (use Rosetta) |

## Building from source

Only needed if you're modifying the C++ fingerprint code. See `chromium-build/src` (branch `weles-147`) and `chromium-build/weles_patch_backup_*/all_changes.patch`. Expect ~4 h on a 16-core host.

When finished, package and upload:

```bash
cd chromium-build/src/out/Weles
tar -czf /tmp/weles-chromium-147-macos-arm64.tar.gz Chromium.app
shasum -a 256 /tmp/weles-chromium-147-macos-arm64.tar.gz | awk '{print $1}' > /tmp/weles-chromium-147-macos-arm64.tar.gz.sha256
gh release upload chromium-147.0.7727.108-weles.1 \
  /tmp/weles-chromium-147-macos-arm64.tar.gz \
  /tmp/weles-chromium-147-macos-arm64.tar.gz.sha256 \
  --repo wisent-ai/weles --clobber
```
