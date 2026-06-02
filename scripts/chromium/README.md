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

## Building & publishing from source

Only needed if you're modifying the C++ fingerprint code. The patch lives in
`chromium-build/src` (branch `weles-147`) + `chromium-build/weles_patch_backup_*/all_changes.patch`.

**One command builds (~4 h on a 16-core host) AND publishes** — so the released
binary can never lag the source:

```bash
bash scripts/chromium/build.sh             # autoninja, then auto-upload + propagate
bash scripts/chromium/build.sh --dry-run   # build, then preview the release (no upload)
```

`build.sh` runs `autoninja` then chains to `release.sh`, which reads the version
from the built binary, creates a fresh `chromium-<ver>-weles.N` GitHub release
(N auto-incremented), bumps the pinned tag in `download.sh`, and commits+pushes.
Every host's 60 s auto-deploy then installs the new binary via `download.sh` and
`find_browser.ts` auto-selects the newest version.

If the binary is already built, publish on its own:

```bash
bash scripts/chromium/release.sh           # package + upload + bump pin + commit + push
```

Never `gh release upload --clobber` onto an existing tag: hosts key on the tag
(the install dir is per-version) and won't notice an in-place replacement. Each
build gets a new `-weles.N` tag — that is what `release.sh` does automatically.
