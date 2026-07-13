import copy
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
import zipfile
from unittest import mock


SCRIPT = pathlib.Path(__file__).with_name("publish-completed-builds.py")
SPEC = importlib.util.spec_from_file_location("publish_completed_builds", SCRIPT)
BROKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BROKER)

SHA = "a" * 40
RUN_ID = 7001
RUN_ATTEMPT = 2
CI_RUN_ID = "6001"
CI_ATTEMPT = 3
ARTIFACT_ID = 8001
REPORTS_ID = 8002
TARGET = "aarch64-apple-darwin"
ARCHIVE_NAME = f"jeden-{TARGET}.tar.gz"


def canonical_bytes(value):
    return (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()


def zip_bytes(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as bundle:
        for name, content in files.items():
            bundle.writestr(name, content)
    return output.getvalue()


class BrokerHarness:
    def __init__(self, root, *, run_mutator=None, ci_run_mutator=None,
                 handoff_mutator=None, provenance_mutator=None,
                 report_mutator=None, reports_present=True, publisher_fails=False):
        self.root = pathlib.Path(root)
        self.publisher_fails = publisher_fails
        self.publisher_calls = []
        self.api_paths = []
        self.download_urls = []
        self.credential_calls = 0

        self.bin = self.root / "skarbiec"
        self.bin.write_text("fake binary\n", encoding="utf-8")
        self.bin.chmod(0o700)
        self.vault = self.root / "vault.json"
        self.vault.write_text("{}\n", encoding="utf-8")
        self.vault.chmod(0o600)
        self.publish_state = self.root / "publisher.sqlite3"
        self.poll_state = self.root / "poll-state.json"
        self.audit_dir = self.root / "audit"

        self.run = {
            "id": RUN_ID,
            "run_attempt": RUN_ATTEMPT,
            "head_sha": SHA,
            "head_branch": "main",
            "head_repository": {"full_name": BROKER.REPOSITORY},
            "conclusion": "success",
            "status": "completed",
            "event": "workflow_run",
            "name": "Canary build evidence",
            "path": ".github/workflows/release.yml",
        }
        if run_mutator:
            run_mutator(self.run)
        self.ci_run = {
            "name": "contractual-ci",
            "path": ".github/workflows/ci.yml",
            "event": "push",
            "status": "completed",
            "conclusion": "success",
            "head_branch": "main",
            "head_sha": SHA,
            "run_attempt": CI_ATTEMPT,
            "head_repository": {"full_name": BROKER.REPOSITORY},
        }
        if ci_run_mutator:
            ci_run_mutator(self.ci_run)

        archive = b"unsigned release archive bytes"
        sbom = canonical_bytes({"SPDXID": "SPDXRef-DOCUMENT", "name": "jeden"})
        provenance = {
            "subject": [{"name": ARCHIVE_NAME, "digest": {"sha256": hashlib.sha256(archive).hexdigest()}}],
            "predicate": {
                "buildDefinition": {
                    "resolvedDependencies": [{"uri": f"git+https://github.com/{BROKER.REPOSITORY}@{SHA}"}]
                },
                "runDetails": {
                    "builder": {"id": f"https://github.com/{BROKER.REPOSITORY}/actions/runs/{RUN_ID}"},
                    "metadata": {"invocationId": f"{RUN_ID}-{RUN_ATTEMPT}"},
                },
            },
        }
        if provenance_mutator:
            provenance_mutator(provenance)
        provenance_bytes = canonical_bytes(provenance)
        handoff = {
            "schema": "jeden.release-build-handoff/v1",
            "repository": BROKER.REPOSITORY,
            "headSha": SHA,
            "version": "1.2.3",
            "minimumVersion": "1.2.0",
            "createdAt": "2026-01-01T00:00:00Z",
            "contractualCiRunId": CI_RUN_ID,
            "contractualCiRunAttempt": CI_ATTEMPT,
            "buildRunId": str(RUN_ID),
            "buildRunAttempt": RUN_ATTEMPT,
            "targetTriple": TARGET,
            "artifact": {"name": ARCHIVE_NAME, "sha256": hashlib.sha256(archive).hexdigest(), "size": len(archive)},
            "sbom": {"name": "sbom.spdx.json", "sha256": hashlib.sha256(sbom).hexdigest()},
            "provenance": {"name": "provenance.intoto.json", "sha256": hashlib.sha256(provenance_bytes).hexdigest()},
        }
        if handoff_mutator:
            handoff_mutator(handoff)
        self.release_zip = zip_bytes({
            ARCHIVE_NAME: archive,
            "build-handoff.json": canonical_bytes(handoff),
            "sbom.spdx.json": sbom,
            "provenance.intoto.json": provenance_bytes,
        })

        interface = {
            "schemaVersion": "jeden.interface-equivalence-report.v1",
            "classification": "Passed",
        }
        migration = {
            "schemaVersion": "jeden.migration-matrix-report.v1",
            "classification": "NotRun",
            "fixtures": [{"classification": "Passed"}],
            "behaviors": [{"classification": "NotRun"}],
        }
        reports = {"interface": interface, "migration": migration}
        if report_mutator:
            report_mutator(reports)
        self.reports_zip = zip_bytes({
            "interface-equivalence-report.json": canonical_bytes(reports["interface"]),
            "migration-matrix-report.json": canonical_bytes(reports["migration"]),
        })
        self.reports_present = reports_present

    @property
    def environment(self):
        return {
            "SKARBIEC_BIN": str(self.bin),
            "SKARBIEC_VAULT_FILE": str(self.vault),
            "SKARBIEC_RELEASE_PUBLISH_STATE": str(self.publish_state),
            "SKARBIEC_RELEASE_AUDIT_DIR": str(self.audit_dir),
            "SKARBIEC_RELEASE_POLL_STATE": str(self.poll_state),
            "GH_TOKEN": "must-not-reach-publisher",
            "GITHUB_TOKEN": "must-not-reach-publisher-either",
        }

    def api_json(self, path, token):
        self.api_paths.append(path)
        if token != "fake-github-token":
            raise AssertionError("API did not receive credential-helper token")
        if path.startswith("/actions/workflows/"):
            return {"workflow_runs": [copy.deepcopy(self.run)]}
        if path == f"/actions/runs/{RUN_ID}/artifacts?per_page=100":
            return {"artifacts": [{"id": ARTIFACT_ID, "name": f"release-{SHA}", "expired": False}]}
        if path == f"/actions/runs/{CI_RUN_ID}":
            return copy.deepcopy(self.ci_run)
        if path == f"/actions/runs/{CI_RUN_ID}/artifacts?per_page=100":
            artifacts = []
            if self.reports_present:
                artifacts.append({
                    "id": REPORTS_ID,
                    "name": f"contractual-reports-{CI_RUN_ID}-{CI_ATTEMPT}",
                    "expired": False,
                })
            return {"artifacts": artifacts}
        raise AssertionError(f"unexpected API path: {path}")

    def download(self, url, destination, token):
        self.download_urls.append(url)
        if token != "fake-github-token":
            raise AssertionError("download did not receive credential-helper token")
        if url.endswith(f"/{ARTIFACT_ID}/zip"):
            destination.write_bytes(self.release_zip)
        elif url.endswith(f"/{REPORTS_ID}/zip"):
            destination.write_bytes(self.reports_zip)
        else:
            raise AssertionError(f"unexpected download URL: {url}")

    def subprocess_run(self, command, **kwargs):
        if command == ["/usr/bin/git", "credential", "fill"]:
            self.credential_calls += 1
            self.assert_credential_request(kwargs)
            return subprocess.CompletedProcess(command, 0, "password=fake-github-token\n", "")
        self.publisher_calls.append((command, kwargs))
        if self.publisher_fails:
            raise subprocess.CalledProcessError(23, command)
        return subprocess.CompletedProcess(command, 0)

    def assert_credential_request(self, kwargs):
        if kwargs.get("input") != "protocol=https\nhost=github.com\n\n":
            raise AssertionError("unexpected credential-helper request")
        if not kwargs.get("check") or not kwargs.get("text"):
            raise AssertionError("credential helper must be checked in text mode")

    def run_main(self):
        with mock.patch.dict(os.environ, self.environment, clear=True), \
                mock.patch.object(BROKER, "api_json", side_effect=self.api_json), \
                mock.patch.object(BROKER, "download", side_effect=self.download), \
                mock.patch.object(BROKER.subprocess, "run", side_effect=self.subprocess_run):
            BROKER.main()


class PublishCompletedBuildsContractTests(unittest.TestCase):
    def make_harness(self, **kwargs):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        return BrokerHarness(temporary.name, **kwargs)

    def assert_rejected(self, harness, message):
        with self.assertRaisesRegex(SystemExit, message):
            harness.run_main()
        self.assertEqual(harness.publisher_calls, [])
        self.assertFalse(harness.poll_state.exists())

    def test_current_release_workflow_run_is_selected(self):
        harness = self.make_harness()

        harness.run_main()

        self.assertIn(f"/actions/runs/{RUN_ID}/artifacts?per_page=100", harness.api_paths)
        self.assertEqual(len(harness.publisher_calls), 1)

    def test_untrusted_release_workflow_runs_are_ignored(self):
        cases = {
            "stale workflow name": lambda run: run.__setitem__("name", "Signed canary release"),
            "wrong workflow name": lambda run: run.__setitem__("name", "contractual-ci"),
            "wrong workflow path": lambda run: run.__setitem__("path", ".github/workflows/other.yml"),
            "wrong event": lambda run: run.__setitem__("event", "push"),
            "wrong repository": lambda run: run["head_repository"].__setitem__("full_name", "attacker/fork"),
            "wrong branch": lambda run: run.__setitem__("head_branch", "feature"),
            "failed conclusion": lambda run: run.__setitem__("conclusion", "failure"),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                harness = self.make_harness(run_mutator=mutate)
                harness.run_main()
                self.assertEqual(harness.credential_calls, 1)
                self.assertEqual(harness.download_urls, [])
                self.assertEqual(harness.publisher_calls, [])
                self.assertFalse(harness.poll_state.exists())

    def test_invalid_release_run_sha_is_rejected_before_download(self):
        harness = self.make_harness(run_mutator=lambda run: run.__setitem__("head_sha", "not-a-sha"))
        self.assert_rejected(harness, "invalid immutable identity")
        self.assertEqual(harness.download_urls, [])

    def test_handoff_rejects_extra_and_mismatched_authority_fields(self):
        cases = {
            "extra field": (lambda handoff: handoff.__setitem__("authority", "github"), "unexpected or missing fields"),
            "wrong repository": (lambda handoff: handoff.__setitem__("repository", "attacker/fork"), "build handoff repository"),
            "wrong SHA": (lambda handoff: handoff.__setitem__("headSha", "b" * 40), "build handoff repository"),
            "wrong run attempt": (lambda handoff: handoff.__setitem__("buildRunAttempt", RUN_ATTEMPT + 1), "build handoff repository"),
        }
        for name, (mutate, message) in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(self.make_harness(handoff_mutator=mutate), message)

    def test_provenance_run_binding_mismatch_is_rejected(self):
        def mutate(provenance):
            provenance["predicate"]["runDetails"]["metadata"]["invocationId"] = f"{RUN_ID}-99"

        self.assert_rejected(self.make_harness(provenance_mutator=mutate), "provenance source SHA or workflow run binding mismatch")

    def test_downloaded_byte_digest_mismatch_is_rejected(self):
        def mutate(handoff):
            handoff["artifact"]["sha256"] = "0" * 64

        self.assert_rejected(self.make_harness(handoff_mutator=mutate), "build handoff does not match downloaded bytes")

    def test_contractual_ci_requires_exact_successful_main_authority(self):
        cases = {
            "wrong workflow": lambda run: run.__setitem__("path", ".github/workflows/release.yml"),
            "wrong repository": lambda run: run["head_repository"].__setitem__("full_name", "attacker/fork"),
            "wrong branch": lambda run: run.__setitem__("head_branch", "feature"),
            "failed conclusion": lambda run: run.__setitem__("conclusion", "failure"),
            "wrong SHA": lambda run: run.__setitem__("head_sha", "b" * 40),
            "wrong run attempt": lambda run: run.__setitem__("run_attempt", CI_ATTEMPT + 1),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(
                    self.make_harness(ci_run_mutator=mutate),
                    "contractual CI authority does not confirm successful main build at exact SHA",
                )

    def test_missing_or_failed_contract_reports_are_rejected(self):
        cases = {
            "missing report artifact": {"reports_present": False, "message": "report artifact is absent"},
            "failed interface report": {
                "report_mutator": lambda reports: reports["interface"].__setitem__("classification", "Failed"),
                "message": "interface equivalence report did not pass",
            },
            "failed migration fixture": {
                "report_mutator": lambda reports: reports["migration"]["fixtures"][0].__setitem__("classification", "Failed"),
                "message": "migration matrix report is not the approved fixture contract result",
            },
        }
        for name, options in cases.items():
            with self.subTest(name=name):
                message = options.pop("message")
                self.assert_rejected(self.make_harness(**options), message)

    def test_publisher_receives_no_github_tokens(self):
        harness = self.make_harness()
        harness.run_main()
        self.assertEqual(harness.credential_calls, 1)
        self.assertEqual(len(harness.publisher_calls), 1)
        command, kwargs = harness.publisher_calls[0]
        self.assertEqual(command[:2], [str(harness.bin), "release-publish"])
        self.assertNotIn("GH_TOKEN", kwargs["env"])
        self.assertNotIn("GITHUB_TOKEN", kwargs["env"])
        self.assertEqual(kwargs["env"]["SKARBIEC_VAULT_FILE"], str(harness.vault))

    def test_poll_state_is_committed_only_after_success_and_prevents_republication(self):
        harness = self.make_harness(publisher_fails=True)
        with self.assertRaises(subprocess.CalledProcessError):
            harness.run_main()
        self.assertFalse(harness.poll_state.exists())

        harness.publisher_fails = False
        harness.run_main()
        identity = f"{RUN_ID}:{RUN_ATTEMPT}:{SHA}"
        self.assertEqual(json.loads(harness.poll_state.read_text(encoding="utf-8")), {"published": [identity]})
        self.assertEqual(len(harness.publisher_calls), 2)

        harness.run_main()
        self.assertEqual(len(harness.publisher_calls), 2)
        self.assertEqual(json.loads(harness.poll_state.read_text(encoding="utf-8")), {"published": [identity]})


if __name__ == "__main__":
    unittest.main()
