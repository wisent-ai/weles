"""Unit tests for weles/scripts/ -- JS file existence and init script assembly."""

import json
from pathlib import Path

import pytest

from weles.scripts import build_init_script, _SCRIPTS_DIR, _SCRIPT_ORDER


SCRIPTS_DIR = Path(__file__).parent.parent / "weles" / "scripts"


class TestJsFilesExist:
    def test_automation_js(self):
        assert (SCRIPTS_DIR / "automation.js").exists()

    def test_navigator_js(self):
        assert (SCRIPTS_DIR / "navigator.js").exists()

    def test_webgl_js(self):
        assert (SCRIPTS_DIR / "webgl.js").exists()

    def test_collect_js(self):
        assert (SCRIPTS_DIR / "collect.js").exists()

    def test_scripts_dir_constant(self):
        assert _SCRIPTS_DIR == SCRIPTS_DIR

    def test_script_order_constant(self):
        assert "automation.js" in _SCRIPT_ORDER
        assert "navigator.js" in _SCRIPT_ORDER
        assert "webgl.js" in _SCRIPT_ORDER


class TestJsFileContents:
    def _read(self, name):
        return (SCRIPTS_DIR / name).read_text()

    def test_automation_js_nonempty(self):
        assert len(self._read("automation.js")) > 100

    def test_navigator_js_nonempty(self):
        assert len(self._read("navigator.js")) > 100

    def test_webgl_js_nonempty(self):
        assert len(self._read("webgl.js")) > 100

    def test_collect_js_nonempty(self):
        assert len(self._read("collect.js")) > 100

    def test_automation_js_hides_webdriver(self):
        content = self._read("automation.js")
        assert "webdriver" in content

    def test_navigator_js_uses_weles_config(self):
        content = self._read("navigator.js")
        assert "__weles" in content

    def test_webgl_js_getparameter(self):
        content = self._read("webgl.js")
        assert "getParameter" in content

    def test_collect_js_function(self):
        content = self._read("collect.js")
        assert "__welesCollectEnvironment" in content


class TestBuildInitScript:
    @pytest.fixture
    def minimal_config(self):
        return {
            "browser": "firefox",
            "navigator": {
                "userAgent": "Mozilla/5.0 Test",
                "platform": "MacIntel",
                "language": "en-US",
                "languages": ["en-US"],
                "hardwareConcurrency": 8,
                "maxTouchPoints": 0,
                "doNotTrack": "unspecified",
                "vendor": "",
                "product": "Gecko",
                "productSub": "20100101",
                "oscpu": "Intel Mac OS X 10.15",
                "buildID": "20250101000000",
                "appVersion": "5.0 (MacIntel)",
            },
            "screen": {"width": 1920, "height": 1080,
                       "availWidth": 1920, "availHeight": 1055,
                       "colorDepth": 24, "pixelDepth": 24},
            "window": {"devicePixelRatio": 1, "outerWidth": 1920, "outerHeight": 1080},
            "webgl": {"vendor": "Mozilla", "renderer": "Apple M1",
                      "unmaskedVendor": "Apple", "unmaskedRenderer": "Apple M1"},
            "canvas": {"noiseSeed": 12345},
            "audio": {"noiseSeed": 67890},
            "fonts": ["Arial", "Helvetica"],
        }

    def test_returns_string(self, minimal_config):
        script = build_init_script(minimal_config)
        assert isinstance(script, str)

    def test_is_iife(self, minimal_config):
        script = build_init_script(minimal_config)
        assert script.strip().startswith("(function()")
        assert script.strip().endswith("})();")

    def test_config_embedded_as_json(self, minimal_config):
        script = build_init_script(minimal_config)
        # The config is JSON-serialized inline
        assert "Mozilla/5.0 Test" in script
        assert "__weles" in script

    def test_deletes_global_config(self, minimal_config):
        script = build_init_script(minimal_config)
        assert "delete window.__weles" in script

    def test_includes_all_scripts(self, minimal_config):
        script = build_init_script(minimal_config)
        # Content from each script should appear
        assert "webdriver" in script       # from automation.js
        assert "getParameter" in script    # from webgl.js

    def test_config_is_valid_json(self, minimal_config):
        script = build_init_script(minimal_config)
        # Extract the JSON portion
        prefix = "const __weles = "
        start = script.index(prefix) + len(prefix)
        # Find matching brace
        depth = 0
        end = start
        for i, ch in enumerate(script[start:], start):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        embedded = script[start:end]
        parsed = json.loads(embedded)
        assert parsed["browser"] == "firefox"

    def test_script_order(self, minimal_config):
        script = build_init_script(minimal_config)
        # automation.js should appear before navigator.js content
        auto_pos = script.find("webdriver")
        nav_pos = script.find("__weles.navigator")
        assert auto_pos < nav_pos, "automation.js should precede navigator.js"
