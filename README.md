# Weles

Browser fingerprint spoofing for Playwright Firefox. JS-level stealth without custom browser binaries.

## Why Weles?

Tools like Camoufox patch Firefox at the C++ level to spoof fingerprints. This works but causes WebGL context crashes inside Cloudflare Turnstile iframes — the spoofing mechanism itself breaks the verification it's trying to bypass.

Weles takes a different approach: it uses **standard Playwright Firefox** (no custom binary) and applies fingerprint spoofing via `addInitScript()` — JavaScript that runs before any page code. WebGL contexts work natively, Turnstile passes, and the fingerprint is still spoofed.

## Install

```bash
pip install weles
playwright install firefox
```

## Usage

```python
from weles import AsyncWeles

async with AsyncWeles(os="macos", locale="en-US") as context:
    page = await context.new_page()
    await page.goto("https://example.com")
```

Sync API:

```python
from weles import Weles

with Weles(os="macos") as context:
    page = context.new_page()
    page.goto("https://example.com")
```

## What it spoofs

- **Navigator**: userAgent, platform, languages, hardwareConcurrency, oscpu, buildID, webdriver
- **Screen/Window**: dimensions, devicePixelRatio, colorDepth
- **WebGL**: vendor, renderer (without breaking contexts)
- **Canvas**: deterministic noise injection
- **Audio**: OfflineAudioContext noise
- **Timezone**: getTimezoneOffset override
- **Automation signals**: removes webdriver, Selenium, Puppeteer markers

## How it works

1. Generates a realistic Firefox fingerprint via [browserforge](https://github.com/nicholasb2101/browserforge)
2. Converts it to a JS config object
3. Injects spoofing scripts via Playwright's `addInitScript()` before any page code runs
4. Overrides are applied on prototypes so they work in iframes too
5. `Function.prototype.toString` is patched so overrides appear as `[native code]`

## License

MIT
