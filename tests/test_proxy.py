"""Unit tests for weles/proxy/ -- ProxyConfig, ProxyPool, providers."""

import pytest
from weles.proxy.config import ProxyConfig
from weles.proxy.pool import ProxyPool
from weles.proxy.providers import (
    PROVIDERS,
    _pingproxies,
    _oxylabs_dc,
    _oxylabs_residential,
    _oxylabs_mobile,
    _smartproxy,
    _iproyal,
    _packetstream,
)


# ---------------------------------------------------------------------------
# ProxyConfig
# ---------------------------------------------------------------------------

class TestProxyConfigUrl:
    def test_url_with_auth(self):
        cfg = ProxyConfig(host="proxy.example.com", port=8080,
                          username="user", password="pass")
        assert cfg.url == "http://user:pass@proxy.example.com:8080"

    def test_url_without_auth(self):
        cfg = ProxyConfig(host="proxy.example.com", port=8080)
        assert cfg.url == "http://proxy.example.com:8080"

    def test_url_socks5(self):
        cfg = ProxyConfig(host="socks.example.com", port=1080,
                          username="u", password="p", protocol="socks5")
        assert cfg.url == "socks5://u:p@socks.example.com:1080"

    def test_url_https_protocol(self):
        cfg = ProxyConfig(host="h.example.com", port=443,
                          username="u", password="p", protocol="https")
        assert cfg.url.startswith("https://")


class TestProxyConfigToPlaywright:
    def test_server_key_present(self):
        cfg = ProxyConfig(host="proxy.example.com", port=8080)
        pw = cfg.to_playwright()
        assert "server" in pw
        assert "proxy.example.com:8080" in pw["server"]

    def test_credentials_included_when_set(self):
        cfg = ProxyConfig(host="h", port=80, username="u", password="p")
        pw = cfg.to_playwright()
        assert pw["username"] == "u"
        assert pw["password"] == "p"

    def test_no_credentials_when_absent(self):
        cfg = ProxyConfig(host="h", port=80)
        pw = cfg.to_playwright()
        assert "username" not in pw
        assert "password" not in pw

    def test_server_format(self):
        cfg = ProxyConfig(host="my.proxy.io", port=3128, protocol="http")
        pw = cfg.to_playwright()
        assert pw["server"] == "http://my.proxy.io:3128"


class TestProxyConfigFromUrl:
    def test_basic_http(self):
        cfg = ProxyConfig.from_url("http://proxy.example.com:8080")
        assert cfg.host == "proxy.example.com"
        assert cfg.port == 8080
        assert cfg.protocol == "http"
        assert cfg.username is None

    def test_with_credentials(self):
        cfg = ProxyConfig.from_url("http://alice:secret@proxy.example.com:3128")
        assert cfg.username == "alice"
        assert cfg.password == "secret"
        assert cfg.host == "proxy.example.com"
        assert cfg.port == 3128

    def test_socks5(self):
        cfg = ProxyConfig.from_url("socks5://user:pass@socks.example.com:1080")
        assert cfg.protocol == "socks5"
        assert cfg.host == "socks.example.com"
        assert cfg.port == 1080

    def test_overrides_applied(self):
        cfg = ProxyConfig.from_url("http://proxy.example.com:8080", country="DE", provider="test")
        assert cfg.country == "DE"
        assert cfg.provider == "test"


class TestProxyConfigStr:
    def test_str_contains_host(self):
        cfg = ProxyConfig(host="myproxy.io", port=8080, provider="testprovider")
        s = str(cfg)
        assert "testprovider" in s
        assert "myproxy.io" in s

    def test_str_contains_country_when_set(self):
        cfg = ProxyConfig(host="myproxy.io", port=8080, country="US")
        s = str(cfg)
        assert "US" in s

    def test_str_without_provider_uses_host(self):
        cfg = ProxyConfig(host="myproxy.io", port=8080)
        s = str(cfg)
        assert "myproxy.io" in s


class TestProxyConfigDefaults:
    def test_default_protocol(self):
        cfg = ProxyConfig(host="h", port=80)
        assert cfg.protocol == "http"

    def test_default_sticky(self):
        cfg = ProxyConfig(host="h", port=80)
        assert cfg.sticky is False

    def test_default_country_none(self):
        cfg = ProxyConfig(host="h", port=80)
        assert cfg.country is None


# ---------------------------------------------------------------------------
# ProxyPool
# ---------------------------------------------------------------------------

FAKE_ENV = {
    "PINGPROXIES_USERNAME": "ppuser",
    "PINGPROXIES_PASSWORD": "pppass",
    "OXYLABS_USERNAME": "oxuser",
    "OXYLABS_PASSWORD": "oxpass",
}


class TestProxyPoolInit:
    def test_no_env_no_providers(self):
        pool = ProxyPool(env={})
        assert pool.available_providers == []

    def test_with_env_detects_providers(self):
        pool = ProxyPool(env=FAKE_ENV)
        assert "pingproxies" in pool.available_providers
        assert "oxylabs" in pool.available_providers

    def test_explicit_provider_list(self):
        pool = ProxyPool(providers=["pingproxies"], env=FAKE_ENV)
        assert pool.available_providers == ["pingproxies"]

    def test_current_starts_none(self):
        pool = ProxyPool(env={})
        assert pool.current is None

    def test_used_ips_starts_empty(self):
        pool = ProxyPool(env={})
        assert len(pool.used_ips) == 0

    def test_repr_shows_providers(self):
        pool = ProxyPool(env=FAKE_ENV)
        r = repr(pool)
        assert "ProxyPool" in r


class TestProxyPoolGet:
    def test_get_returns_proxy_config(self):
        pool = ProxyPool(env=FAKE_ENV)
        cfg = pool.get()
        assert isinstance(cfg, ProxyConfig)

    def test_get_sets_current(self):
        pool = ProxyPool(env=FAKE_ENV)
        cfg = pool.get()
        assert pool.current is cfg

    def test_get_no_providers_raises(self):
        pool = ProxyPool(env={})
        with pytest.raises(RuntimeError, match="No proxy providers configured"):
            pool.get()

    def test_get_country_override(self):
        pool = ProxyPool(env=FAKE_ENV, country="US")
        cfg = pool.get(country="DE")
        assert cfg.country == "DE"

    def test_get_sticky_override(self):
        pool = ProxyPool(env=FAKE_ENV, sticky=False)
        cfg = pool.get(sticky=True)
        assert cfg.sticky is True

    def test_get_specific_provider(self):
        pool = ProxyPool(env=FAKE_ENV)
        cfg = pool.get(provider="pingproxies")
        assert cfg.provider == "pingproxies"

    def test_get_unknown_provider_raises(self):
        pool = ProxyPool(env=FAKE_ENV)
        with pytest.raises((ValueError, RuntimeError)):
            pool.get(provider="nonexistent_provider_xyz")


class TestProxyPoolRotate:
    def test_rotate_advances_index(self):
        pool = ProxyPool(env=FAKE_ENV)
        pool.get()
        idx_before = pool._index
        pool.rotate()
        assert pool._index == idx_before + 1

    def test_rotate_returns_proxy_config(self):
        pool = ProxyPool(env=FAKE_ENV)
        cfg = pool.rotate()
        assert isinstance(cfg, ProxyConfig)


class TestProxyPoolCustom:
    def test_add_custom_used_when_no_providers(self):
        pool = ProxyPool(env={})
        pool.add_custom("http://user:pass@proxy.example.com:8080")
        cfg = pool.get()
        assert cfg.host == "proxy.example.com"

    def test_add_custom_multiple(self):
        pool = ProxyPool(env={})
        pool.add_custom("http://p1.example.com:8080")
        pool.add_custom("http://p2.example.com:8080")
        assert len(pool._custom_pool) == 2

    def test_add_custom_with_overrides(self):
        pool = ProxyPool(env={})
        pool.add_custom("http://proxy.example.com:8080", country="JP")
        cfg = pool.get()
        assert cfg.country == "JP"


class TestProxyPoolListProviders:
    def test_returns_all_seven(self):
        pool = ProxyPool(env={})
        providers = pool.list_providers()
        assert len(providers) == 7

    def test_each_entry_has_required_keys(self):
        pool = ProxyPool(env={})
        for p in pool.list_providers():
            assert "id" in p
            assert "name" in p
            assert "cost_per_gb" in p
            assert "configured" in p

    def test_configured_false_without_env(self):
        pool = ProxyPool(env={})
        for p in pool.list_providers():
            assert p["configured"] is False

    def test_configured_true_with_env(self):
        pool = ProxyPool(env=FAKE_ENV)
        pp = next(p for p in pool.list_providers() if p["id"] == "pingproxies")
        assert pp["configured"] is True


# ---------------------------------------------------------------------------
# Provider credential builders
# ---------------------------------------------------------------------------

class TestProviderBuilders:
    def test_pingproxies_country_format(self):
        user, pwd = _pingproxies("alice", "secret", "US", False)
        assert "alice" in user
        assert "_c_us" in user
        assert pwd == "secret"

    def test_pingproxies_sticky_adds_session(self):
        user, _ = _pingproxies("alice", "secret", "US", True)
        assert "_s_" in user

    def test_pingproxies_no_sticky_no_session(self):
        user, _ = _pingproxies("alice", "secret", "US", False)
        assert "_s_" not in user

    def test_oxylabs_dc_prefix(self):
        user, _ = _oxylabs_dc("bob", "pass", "US", False)
        assert user.startswith("user-")

    def test_oxylabs_residential_customer_prefix(self):
        user, _ = _oxylabs_residential("carol", "pass", "US", False)
        assert "customer-carol" in user
        assert "-cc-us" in user

    def test_oxylabs_residential_sticky(self):
        user, _ = _oxylabs_residential("carol", "pass", "US", True)
        assert "-sessid-" in user

    def test_oxylabs_mobile_uppercase_country(self):
        user, _ = _oxylabs_mobile("dave", "pass", "gb", False)
        assert "-cc-GB" in user

    def test_smartproxy_format(self):
        user, _ = _smartproxy("eve", "pass", "US", False)
        assert "user-eve-country-us" in user

    def test_smartproxy_sticky(self):
        user, _ = _smartproxy("eve", "pass", "US", True)
        assert "-session-" in user

    def test_iproyal_country_in_password(self):
        user, pwd = _iproyal("frank", "pass", "US", False)
        assert user == "frank"
        assert "_country-us" in pwd

    def test_iproyal_sticky_in_password(self):
        _, pwd = _iproyal("frank", "pass", "US", True)
        assert "_session-" in pwd

    def test_packetstream_uppercase_country(self):
        user, pwd = _packetstream("grace", "pass", "us", False)
        assert "_country-US" in pwd

    def test_packetstream_sticky(self):
        _, pwd = _packetstream("grace", "pass", "US", True)
        assert "_session-" in pwd


class TestProvidersRegistry:
    def test_all_providers_have_required_keys(self):
        required = ("name", "host", "port", "env_user", "env_pass",
                    "cost_per_gb", "build_creds")
        for pid, spec in PROVIDERS.items():
            for key in required:
                assert key in spec, f"Provider {pid!r} missing key {key!r}"

    def test_build_creds_callable(self):
        for pid, spec in PROVIDERS.items():
            assert callable(spec["build_creds"]), f"{pid} build_creds not callable"

    def test_seven_providers_registered(self):
        assert len(PROVIDERS) == 7
