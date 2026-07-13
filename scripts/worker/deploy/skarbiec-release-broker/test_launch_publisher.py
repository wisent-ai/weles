import os
import pathlib
import subprocess
import tempfile
import textwrap
import unittest


LAUNCHER = pathlib.Path(__file__).with_name("launch-publisher.sh")
DEDICATED_UNLOCK = "DEDICATED_UNLOCK_MARKER"
WORKER_UNLOCK = "WORKER_UNLOCK_MARKER"
AMBIENT_UNLOCK = "AMBIENT_UNLOCK_MARKER"
SECRET_MARKERS = (DEDICATED_UNLOCK, WORKER_UNLOCK, AMBIENT_UNLOCK)


class LaunchPublisherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = pathlib.Path(self.temporary.name)
        self.home = self.root / "home"
        self.home.mkdir(mode=0o700)
        self.secrets = self.home / ".weles-secrets"
        self.secrets.mkdir(mode=0o700)
        self.vault = self.secrets / "dedicated-release.vault.json"
        self.vault.write_text("{}\n", encoding="utf-8")
        self.vault.chmod(0o600)
        self.publisher_env = self.secrets / "skarbiec-release-publisher.env"

        self.weles = self.root / "weles"
        broker = self.weles / "scripts/worker/deploy/skarbiec-release-broker"
        broker.mkdir(parents=True)
        publisher = broker / "publish-completed-builds.py"
        publisher.write_text(
            textwrap.dedent(
                f"""\
                import os
                import sys

                def require(condition, name):
                    if not condition:
                        print("publisher-contract-failure:" + name, file=sys.stderr)
                        raise SystemExit(91)

                require(os.environ.get("SKARBIEC_VAULT_FILE") == {str(self.vault)!r}, "vault")
                require(os.environ.get("SKARBIEC_UNLOCK") == {DEDICATED_UNLOCK!r}, "unlock")
                require("WORKER_ONLY" not in os.environ, "worker-environment")
                require("AMBIENT_ONLY" not in os.environ, "ambient-environment")
                print("publisher-ok")
                """
            ),
            encoding="utf-8",
        )

        worker_env = self.weles / "var/worker.env"
        worker_env.parent.mkdir(parents=True)
        worker_env.write_text(
            f"SKARBIEC_VAULT_FILE={self.vault}\n"
            f"SKARBIEC_UNLOCK={WORKER_UNLOCK}\n"
            "WORKER_ONLY=present\n",
            encoding="utf-8",
        )
        worker_env.chmod(0o600)

    def write_publisher_env(self, content, mode=0o600):
        self.publisher_env.write_text(content, encoding="utf-8")
        self.publisher_env.chmod(mode)

    def valid_environment(self, vault=None):
        return (
            f"SKARBIEC_VAULT_FILE={vault or self.vault}\n"
            f"SKARBIEC_UNLOCK={DEDICATED_UNLOCK}\n"
        )

    def run_launcher(self):
        environment = os.environ.copy()
        environment.update(
            {
                "HOME": str(self.home),
                "WELES_DIR": str(self.weles),
                "SKARBIEC_VAULT_FILE": str(self.root / "ambient.vault.json"),
                "SKARBIEC_UNLOCK": AMBIENT_UNLOCK,
                "WORKER_ONLY": "ambient-worker-marker",
                "AMBIENT_ONLY": "present",
            }
        )
        result = subprocess.run(
            ["/bin/bash", str(LAUNCHER)],
            env=environment,
            text=True,
            capture_output=True,
            check=False,
            timeout=10,
        )
        combined_output = result.stdout + result.stderr
        for marker in SECRET_MARKERS:
            self.assertNotIn(marker, combined_output)
        return result

    def assert_rejected(self, content, *, env_mode=0o600, vault_mode=0o600):
        self.write_publisher_env(content, mode=env_mode)
        self.vault.chmod(vault_mode)
        result = self.run_launcher()
        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("publisher-ok", result.stdout)

    def test_exact_two_key_environment_reaches_publisher(self):
        self.write_publisher_env(self.valid_environment())

        result = self.run_launcher()

        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(result.stdout, "publisher-ok\n")
        self.assertEqual(result.stderr, "")

    def test_missing_required_key_is_rejected(self):
        cases = {
            "missing vault": f"SKARBIEC_UNLOCK={DEDICATED_UNLOCK}\n",
            "missing unlock": f"SKARBIEC_VAULT_FILE={self.vault}\n",
        }
        for name, content in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(content)

    def test_duplicate_key_is_rejected_even_when_first_value_is_empty(self):
        cases = {
            "duplicate vault": (
                f"SKARBIEC_VAULT_FILE={self.vault}\n"
                f"SKARBIEC_VAULT_FILE={self.vault}\n"
                f"SKARBIEC_UNLOCK={DEDICATED_UNLOCK}\n"
            ),
            "duplicate unlock": (
                f"SKARBIEC_VAULT_FILE={self.vault}\n"
                f"SKARBIEC_UNLOCK={DEDICATED_UNLOCK}\n"
                f"SKARBIEC_UNLOCK={DEDICATED_UNLOCK}\n"
            ),
            "empty first vault": (
                "SKARBIEC_VAULT_FILE=\n"
                f"SKARBIEC_VAULT_FILE={self.vault}\n"
                f"SKARBIEC_UNLOCK={DEDICATED_UNLOCK}\n"
            ),
            "empty first unlock": (
                f"SKARBIEC_VAULT_FILE={self.vault}\n"
                "SKARBIEC_UNLOCK=\n"
                f"SKARBIEC_UNLOCK={DEDICATED_UNLOCK}\n"
            ),
        }
        for name, content in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(content)

    def test_unknown_key_is_rejected(self):
        self.assert_rejected(self.valid_environment() + "UNEXPECTED_KEY=value\n")

    def test_environment_is_parsed_as_data_not_sourced(self):
        sentinel = self.root / "must-not-be-created"
        content = (
            f"SKARBIEC_VAULT_FILE={self.vault}\n"
            f"SKARBIEC_UNLOCK=$(/usr/bin/touch {sentinel})\n"
        )

        self.assert_rejected(content)

        self.assertFalse(sentinel.exists())


    def test_unsafe_environment_or_vault_mode_is_rejected(self):
        cases = {
            "group-readable environment": (0o640, 0o600),
            "other-readable vault": (0o600, 0o604),
        }
        for name, (env_mode, vault_mode) in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(
                    self.valid_environment(),
                    env_mode=env_mode,
                    vault_mode=vault_mode,
                )

    def test_relative_vault_path_is_rejected(self):
        self.assert_rejected(self.valid_environment(vault="relative/release.vault.json"))

    def test_worker_environment_and_login_keychain_are_not_fallbacks(self):
        source = LAUNCHER.read_text(encoding="utf-8")
        self.assertNotIn("worker.env", source)
        self.assertNotIn("security", source)

        result = self.run_launcher()

        self.assertNotEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("publisher-ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
