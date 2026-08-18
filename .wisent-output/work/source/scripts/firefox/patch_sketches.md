# Firefox Gecko Patch Sketches

Concrete pseudo-diff specs for the four remaining Phase 2 patches. Written so
the patch-writing session against a cloned mozilla-central can diff-and-apply
rather than re-research each file. Pair with `firefox-build/README.md`.

All four patches read from a new weles pref group. The pref names and format
are defined in a single place — `modules/libpref/init/all.js` (or equivalent
static pref list) — then consumed by the patch sites. Pref names:

```
weles.fingerprint.webdriver.force        bool     default true (= hide webdriver)
weles.fingerprint.webgl.vendor           string   empty = unset, use native
weles.fingerprint.webgl.renderer         string   empty = unset, use native
weles.fingerprint.screen.width           int      0    = unset, use native
weles.fingerprint.screen.height          int      0    = unset, use native
weles.fingerprint.screen.avail_width     int      0    = unset, use native
weles.fingerprint.screen.avail_height    int      0    = unset, use native
weles.fingerprint.window.outer_width     int      0    = unset, use native
weles.fingerprint.window.outer_height    int      0    = unset, use native
weles.fingerprint.window.screen_x        int      0    = unset, use native
weles.fingerprint.window.screen_y        int      0    = unset, use native
```

`async_api.ts` firefoxUserPrefs builder will set these from `fpConfig.screen.*`
and `fpConfig.window.*` after Phase 2 lands; for now they default to "unset"
(= native) so the patched binary is a drop-in replacement for stock Firefox
when the prefs are absent.

---

## P2.2 — navigator.webdriver honoured even under Playwright juggler

**Why:** `dom.webdriver.enabled=false` is respected by stock Firefox but
Playwright's juggler binary branch hardcodes `webdriver=true` during automation
runs. Our P1.3 pref flip + automation.js JS scrub work but are bypassable from
iframes / workers / trusted-types-sandboxed contexts.

**File:** `dom/base/Navigator.cpp` — `Navigator::Webdriver(bool* aWebdriver)`
(or the equivalent returning the bool; check getter name against the current
Firefox tree at build time).

**Current:**

```cpp
bool Navigator::Webdriver() {
  return Preferences::GetBool("dom.webdriver.enabled", false) ||
         NS_GetEnvOrPref("MOZ_AUTOMATION", false);
}
```

**Replacement:**

```cpp
bool Navigator::Webdriver() {
  // weles fingerprint override: when weles.fingerprint.webdriver.force is
  // true (the default when the pref group is registered), suppress the
  // webdriver flag regardless of automation launch mode. This is what lets
  // a weles-patched Firefox pass navigator.webdriver === undefined even
  // when juggler is driving the session.
  if (Preferences::GetBool("weles.fingerprint.webdriver.force", true)) {
    return false;
  }
  return Preferences::GetBool("dom.webdriver.enabled", false) ||
         NS_GetEnvOrPref("MOZ_AUTOMATION", false);
}
```

Note: juggler may set `navigator.webdriver` on the page via a separate
injection path (check `testing/mozbase/mozrunner/.../juggler/content/main.js`
and the CDP-equivalent hooks). A second patch site there may be needed.

---

## P2.3 — WebGL vendor/renderer without Firefox's value normalization

**Why:** Firefox 137 already has `webgl.vendor-string-override` and
`webgl.renderer-string-override` prefs, but Gecko runs the values through a
normalizer that:

- Coerces "Apple Inc." → "Apple"
- Replaces the renderer string with "<vendor> M1, or similar" when the
  renderer contains a GPU family name.

Our audit (`scripts/firefox/prefs_audit.mjs`, 2026-04-23) confirmed both
mismatches. Real Chrome does not normalize these values; weles fingerprint
configs need the raw string.

**File:** `dom/canvas/WebGLContext.cpp` — `WebGLContext::GetParameter` for
`UNMASKED_VENDOR_WEBGL` and `UNMASKED_RENDERER_WEBGL` cases (WEBGL_debug_renderer_info
extension).

**Current (search the file for `UNMASKED_VENDOR_WEBGL`):**

```cpp
case LOCAL_GL_UNMASKED_VENDOR_WEBGL: {
  nsCString override;
  Preferences::GetCString("webgl.vendor-string-override", override);
  if (!override.IsEmpty()) {
    // Firefox applies its built-in sanitizer here — drops details, normalizes.
    return SanitizeVendorString(override);
  }
  return ... // native vendor
}
```

**Replacement:**

```cpp
case LOCAL_GL_UNMASKED_VENDOR_WEBGL: {
  // weles fingerprint override: bypass Firefox's sanitizer so the raw
  // string our fingerprint config supplied is what the page sees.
  nsCString weles;
  Preferences::GetCString("weles.fingerprint.webgl.vendor", weles);
  if (!weles.IsEmpty()) return weles;
  nsCString override;
  Preferences::GetCString("webgl.vendor-string-override", override);
  if (!override.IsEmpty()) return SanitizeVendorString(override);
  return ... // native vendor
}
```

Mirror the same pattern for `LOCAL_GL_UNMASKED_RENDERER_WEBGL` and the
`weles.fingerprint.webgl.renderer` pref.

---

## P2.4 — Screen dimensions overridable

**Why:** `screen.width` / `screen.height` / `screen.availWidth` /
`screen.availHeight` drive many fingerprint surfaces. Stock Firefox reports
the real OS-reported display dimensions with no pref override. The weles
fingerprint config carries per-persona screen sizes; we need them honoured
at the engine level so iframe-world JS sees the same values.

**File:** `dom/base/Screen.cpp` — `Screen::GetWidth`, `Screen::GetHeight`,
`Screen::GetAvailWidth`, `Screen::GetAvailHeight`.

**Current:**

```cpp
int32_t Screen::GetWidth(CallerType aCallerType, ErrorResult& aRv) {
  // returns real display width from gfx::Screen or resistFingerprinting stub
  ...
}
```

**Replacement:** insert at the top of each getter:

```cpp
int32_t Screen::GetWidth(CallerType aCallerType, ErrorResult& aRv) {
  int32_t welesW = Preferences::GetInt("weles.fingerprint.screen.width", 0);
  if (welesW > 0) return welesW;
  // ... original body unchanged ...
}
```

Do the same for height, availWidth, availHeight, each with its own pref.

Note: `colorDepth` and `pixelDepth` are hardcoded to 24 in Firefox already
(no fingerprint surface there), skip.

`devicePixelRatio` lives on `nsGlobalWindowInner` not `Screen` — may be
worth a follow-up patch if the Phase-1 init-script navigator/webgl stack
doesn't already spoof it.

---

## P2.5 — Window outer dimensions overridable

**Why:** `window.outerWidth` / `window.outerHeight` / `window.screenX` /
`window.screenY` drive the "browser chrome + OS decoration" part of the
fingerprint. Stock Firefox reports real values from the platform widget
layer. Our P1 init scripts spoof these in JS but iframes and workers
bypass them.

**File:** `dom/base/nsGlobalWindowOuter.cpp` — `nsGlobalWindowOuter::GetOuterWidth`,
`GetOuterHeight`, `GetScreenX`, `GetScreenY`.

**Current:**

```cpp
int32_t nsGlobalWindowOuter::GetOuterWidth(CallerType aCallerType,
                                           ErrorResult& aError) {
  // computes real chrome width from nsIBaseWindow
  ...
}
```

**Replacement:** insert at the top of each getter:

```cpp
int32_t nsGlobalWindowOuter::GetOuterWidth(CallerType aCallerType,
                                           ErrorResult& aError) {
  int32_t welesW = Preferences::GetInt("weles.fingerprint.window.outer_width", 0);
  if (welesW > 0) return welesW;
  // ... original body unchanged ...
}
```

Same pattern for outerHeight, screenX, screenY.

---

## Patch file naming convention in `firefox-build/patches/`

```
0001-weles-prefs-register.patch                # modules/libpref + default values
0002-weles-navigator-webdriver.patch           # P2.2
0003-weles-webgl-vendor-renderer.patch         # P2.3
0004-weles-screen-overrides.patch              # P2.4
0005-weles-window-outer-overrides.patch        # P2.5
```

Use `hg export` against a named bookmark or `git format-patch` if the tree
is in git mode; either format applies cleanly with `hg import --no-commit`
or `git apply`.
