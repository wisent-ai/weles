"""Unit tests for weles/fingerprint.py."""

import pytest
from weles.fingerprint import (
    generate,
    to_config,
    _default_webgl_renderer,
    _default_webgl_unmasked_vendor,
    _default_fonts,
    _deep_merge,
    _PLATFORM_MAP,
    _OSCPU_MAP,
)


# ---------------------------------------------------------------------------
# generate()
# ---------------------------------------------------------------------------

class TestGenerate:
    def test_macos(self):
        fp = generate(os="macos")
        assert fp is not None

    def test_windows(self):
        fp = generate(os="windows")
        assert fp is not None

    def test_linux(self):
        fp = generate(os="linux")
        assert fp is not None

    def test_none_os_picks_random(self):
        # Should not raise; OS is chosen randomly
        fp = generate(os=None)
        assert fp is not None

    def test_list_os(self):
        fp = generate(os=["macos", "windows"])
        assert fp is not None

    def test_firefox_default(self):
        fp = generate(os="macos", browser="firefox")
        assert fp is not None

    def test_chromium(self):
        fp = generate(os="macos", browser="chromium")
        assert fp is not None

    def test_has_navigator(self):
        fp = generate(os="macos")
        assert hasattr(fp, "navigator")

    def test_has_screen(self):
        fp = generate(os="macos")
        assert hasattr(fp, "screen")


# ---------------------------------------------------------------------------
# to_config()
# ---------------------------------------------------------------------------

class TestToConfig:
    @pytest.fixture(autouse=True)
    def fp_macos(self):
        self.fp = generate(os="macos", browser="firefox")

    def _config(self, **kwargs):
        return to_config(self.fp, **kwargs)

    def test_required_top_level_keys(self):
        cfg = self._config(target_os="macos")
        for key in ("browser", "navigator", "screen", "window", "webgl", "canvas", "audio", "fonts"):
            assert key in cfg, f"Missing key: {key}"

    def test_browser_field_firefox(self):
        cfg = self._config(target_os="macos", browser="firefox")
        assert cfg["browser"] == "firefox"

    def test_browser_field_chromium(self):
        fp = generate(os="macos", browser="chromium")
        cfg = to_config(fp, target_os="macos", browser="chromium")
        assert cfg["browser"] == "chromium"

    def test_navigator_keys_firefox(self):
        cfg = self._config(target_os="macos", browser="firefox")
        nav = cfg["navigator"]
        for key in ("userAgent", "platform", "language", "languages",
                    "hardwareConcurrency", "maxTouchPoints", "doNotTrack",
                    "oscpu", "buildID", "vendor", "product", "productSub"):
            assert key in nav, f"Missing navigator key: {key}"

    def test_navigator_platform_macos(self):
        cfg = self._config(target_os="macos")
        assert cfg["navigator"]["platform"] == "MacIntel"

    def test_navigator_platform_windows(self):
        fp = generate(os="windows")
        cfg = to_config(fp, target_os="windows")
        assert cfg["navigator"]["platform"] == "Win32"

    def test_navigator_platform_linux(self):
        fp = generate(os="linux")
        cfg = to_config(fp, target_os="linux")
        assert cfg["navigator"]["platform"] == "Linux x86_64"

    def test_oscpu_macos(self):
        cfg = self._config(target_os="macos")
        assert "Mac" in cfg["navigator"]["oscpu"]

    def test_oscpu_windows(self):
        fp = generate(os="windows")
        cfg = to_config(fp, target_os="windows")
        assert "Windows" in cfg["navigator"]["oscpu"]

    def test_chromium_no_oscpu(self):
        fp = generate(os="macos", browser="chromium")
        cfg = to_config(fp, target_os="macos", browser="chromium")
        assert "oscpu" not in cfg["navigator"]

    def test_chromium_no_buildid(self):
        fp = generate(os="macos", browser="chromium")
        cfg = to_config(fp, target_os="macos", browser="chromium")
        assert "buildID" not in cfg["navigator"]

    def test_chromium_has_device_memory(self):
        fp = generate(os="macos", browser="chromium")
        cfg = to_config(fp, target_os="macos", browser="chromium")
        assert "deviceMemory" in cfg["navigator"]
        assert cfg["navigator"]["deviceMemory"] in (4, 8, 16)

    def test_chromium_vendor_google(self):
        fp = generate(os="macos", browser="chromium")
        cfg = to_config(fp, target_os="macos", browser="chromium")
        assert cfg["navigator"]["vendor"] == "Google Inc."

    def test_firefox_vendor_empty(self):
        cfg = self._config(target_os="macos", browser="firefox")
        assert cfg["navigator"]["vendor"] == ""

    def test_screen_keys(self):
        cfg = self._config(target_os="macos")
        for key in ("width", "height", "availWidth", "availHeight", "colorDepth", "pixelDepth"):
            assert key in cfg["screen"], f"Missing screen key: {key}"

    def test_screen_dimensions_positive(self):
        cfg = self._config(target_os="macos")
        assert cfg["screen"]["width"] > 0
        assert cfg["screen"]["height"] > 0

    def test_window_keys(self):
        cfg = self._config(target_os="macos")
        for key in ("devicePixelRatio", "outerWidth", "outerHeight"):
            assert key in cfg["window"], f"Missing window key: {key}"

    def test_webgl_keys(self):
        cfg = self._config(target_os="macos")
        for key in ("vendor", "renderer", "unmaskedVendor", "unmaskedRenderer"):
            assert key in cfg["webgl"], f"Missing webgl key: {key}"

    def test_canvas_noise_seed(self):
        cfg = self._config(target_os="macos")
        seed = cfg["canvas"]["noiseSeed"]
        assert isinstance(seed, int)
        assert seed >= 1

    def test_audio_noise_seed(self):
        cfg = self._config(target_os="macos")
        seed = cfg["audio"]["noiseSeed"]
        assert isinstance(seed, int)
        assert seed >= 1

    def test_fonts_is_list(self):
        cfg = self._config(target_os="macos")
        assert isinstance(cfg["fonts"], list)
        assert len(cfg["fonts"]) > 0

    def test_config_overrides_flat(self):
        overrides = {"canvas": {"noiseSeed": 42}}
        cfg = to_config(self.fp, target_os="macos", config_overrides=overrides)
        assert cfg["canvas"]["noiseSeed"] == 42

    def test_config_overrides_deep(self):
        overrides = {"navigator": {"hardwareConcurrency": 99}}
        cfg = to_config(self.fp, target_os="macos", config_overrides=overrides)
        assert cfg["navigator"]["hardwareConcurrency"] == 99
        # Other navigator keys still present
        assert "userAgent" in cfg["navigator"]

    def test_config_overrides_none(self):
        cfg = to_config(self.fp, target_os="macos", config_overrides=None)
        assert "navigator" in cfg


# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------

class TestDefaultWebglRenderer:
    def test_macos(self):
        r = _default_webgl_renderer("macos")
        assert isinstance(r, str) and len(r) > 0

    def test_windows(self):
        r = _default_webgl_renderer("windows")
        assert "ANGLE" in r or "Intel" in r or len(r) > 0

    def test_linux(self):
        r = _default_webgl_renderer("linux")
        assert isinstance(r, str) and len(r) > 0

    def test_unknown_falls_back(self):
        r = _default_webgl_renderer("unknown_os")
        # Should fall back to macos value
        assert r == _default_webgl_renderer("macos")


class TestDefaultWebglUnmaskedVendor:
    def test_macos(self):
        assert _default_webgl_unmasked_vendor("macos") == "Apple"

    def test_windows(self):
        v = _default_webgl_unmasked_vendor("windows")
        assert "Intel" in v or "Google" in v

    def test_linux(self):
        assert _default_webgl_unmasked_vendor("linux") == "Intel"

    def test_unknown_falls_back(self):
        v = _default_webgl_unmasked_vendor("alien_os")
        assert v == _default_webgl_unmasked_vendor("macos")


class TestDefaultFonts:
    def test_base_fonts_present(self):
        base = {"Arial", "Courier New", "Georgia", "Helvetica", "Times New Roman", "Verdana"}
        for os_name in ("macos", "windows", "linux"):
            fonts = set(_default_fonts(os_name))
            assert base.issubset(fonts), f"Missing base fonts for {os_name}"

    def test_macos_extra_fonts(self):
        fonts = _default_fonts("macos")
        assert "Menlo" in fonts

    def test_windows_extra_fonts(self):
        fonts = _default_fonts("windows")
        assert "Segoe UI" in fonts

    def test_returns_list(self):
        assert isinstance(_default_fonts("macos"), list)


class TestDeepMerge:
    def test_flat_merge(self):
        target = {"a": 1, "b": 2}
        _deep_merge(target, {"b": 99, "c": 3})
        assert target == {"a": 1, "b": 99, "c": 3}

    def test_nested_merge(self):
        target = {"nav": {"ua": "old", "platform": "mac"}}
        _deep_merge(target, {"nav": {"ua": "new"}})
        assert target["nav"]["ua"] == "new"
        assert target["nav"]["platform"] == "mac"

    def test_overwrite_non_dict(self):
        target = {"a": [1, 2]}
        _deep_merge(target, {"a": [3, 4]})
        assert target["a"] == [3, 4]

    def test_empty_source(self):
        target = {"a": 1}
        _deep_merge(target, {})
        assert target == {"a": 1}

    def test_empty_target(self):
        target = {}
        _deep_merge(target, {"a": 1})
        assert target == {"a": 1}


class TestPlatformAndOscpuMaps:
    def test_platform_map_coverage(self):
        for os_name in ("macos", "windows", "linux"):
            assert os_name in _PLATFORM_MAP

    def test_oscpu_map_coverage(self):
        for os_name in ("macos", "windows", "linux"):
            assert os_name in _OSCPU_MAP
