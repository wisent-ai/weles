#!/usr/bin/env python3
"""Pull successful Jeden release artifacts and publish them through local Skarbiec."""

import datetime
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile

REPOSITORY = "Wisent-AI/jeden"
WORKFLOW = "release.yml"
API = f"https://api.github.com/repos/{REPOSITORY}"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")

class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        redirected = super().redirect_request(request, file_pointer, code, message, headers, new_url)
        if redirected is not None and urllib.parse.urlsplit(request.full_url).netloc != urllib.parse.urlsplit(new_url).netloc:
            redirected.remove_header("Authorization")
        return redirected


DOWNLOAD_OPENER = urllib.request.build_opener(SafeRedirect())


def fail(message: str) -> "NoReturn":
    raise SystemExit(message)


def require_owner_only(path: pathlib.Path, *, directory=None) -> None:
    info = path.stat()
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o077:
        fail(f"unsafe owner or mode: {path}")
    if directory is True and not path.is_dir():
        fail(f"required directory is unavailable: {path}")
    if directory is False and not path.is_file():
        fail(f"required file is unavailable: {path}")


def github_token() -> str:
    result = subprocess.run(
        ["/usr/bin/git", "credential", "fill"],
        input="protocol=https\nhost=github.com\n\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=True,
    )
    values = dict(line.split("=", 1) for line in result.stdout.splitlines() if "=" in line)
    token = values.get("password", "")
    if not token:
        fail("GitHub credential helper returned no credential")
    return token


def api_json(path: str, token: str) -> dict:
    request = urllib.request.Request(
        API + path,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "weles-skarbiec-release-publisher",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def download(url: str, destination: pathlib.Path, token: str) -> None:
    request = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "weles-skarbiec-release-publisher",
        },
    )
    with DOWNLOAD_OPENER.open(request, timeout=120) as response, destination.open("wb") as output:
        shutil.copyfileobj(response, output)


def extract_zip(archive: pathlib.Path, destination: pathlib.Path) -> None:
    destination.mkdir(mode=0o700)
    root = destination.resolve()
    with zipfile.ZipFile(archive) as bundle:
        if not bundle.infolist():
            fail("release artifact zip is empty")
        for member in bundle.infolist():
            target = (destination / member.filename).resolve()
            if target != root and root not in target.parents:
                fail("release artifact contains path traversal")
            mode = member.external_attr >> 16
            if stat.S_ISLNK(mode):
                fail("release artifact contains a symbolic link")
        bundle.extractall(destination)
    for path in destination.rglob("*"):
        path.chmod(0o700 if path.is_dir() else 0o600)

def digest(path: pathlib.Path) -> str:
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def canonical_json(path: pathlib.Path) -> dict:
    raw = path.read_bytes()
    value = json.loads(raw)
    if not isinstance(value, dict):
        fail(f"expected JSON object: {path.name}")
    expected = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
    if raw != expected:
        fail(f"non-canonical JSON: {path.name}")
    return value


def exact_keys(value: dict, keys: set[str], label: str) -> None:
    if set(value) != keys:
        fail(f"{label} has unexpected or missing fields")


def fetch_contract_reports(token: str, root: pathlib.Path, ci_run_id: str, ci_attempt: int, sha: str) -> dict:
    run = api_json(f"/actions/runs/{ci_run_id}", token)
    repository = run.get("head_repository") or {}
    if (run.get("name") != "contractual-ci" or run.get("path") != ".github/workflows/ci.yml" or
            run.get("event") != "push" or run.get("status") != "completed" or run.get("conclusion") != "success" or
            run.get("head_branch") != "main" or run.get("head_sha") != sha or run.get("run_attempt") != ci_attempt or
            repository.get("full_name", "").lower() != REPOSITORY.lower()):
        fail("contractual CI authority does not confirm successful main build at exact SHA")
    artifacts = api_json(f"/actions/runs/{ci_run_id}/artifacts?per_page=100", token).get("artifacts")
    expected_name = f"contractual-reports-{ci_run_id}-{ci_attempt}"
    reports = [item for item in artifacts or [] if item.get("name") == expected_name and item.get("expired") is False]
    if len(reports) != 1 or not isinstance(reports[0].get("id"), int):
        fail("contractual CI report artifact is absent, expired, or ambiguous")
    with tempfile.TemporaryDirectory(prefix="contract-reports-", dir=str(root.parent)) as temporary:
        report_root = pathlib.Path(temporary)
        archive = report_root / "reports.zip"
        download(f"{API}/actions/artifacts/{reports[0]['id']}/zip", archive, token)
        extracted = report_root / "extracted"
        extract_zip(archive, extracted)
        files = [path for path in extracted.iterdir() if path.is_file()]
        expected = {"interface-equivalence-report.json", "migration-matrix-report.json"}
        if any(path.is_dir() for path in extracted.iterdir()) or {path.name for path in files} != expected:
            fail("contractual CI report file allowlist mismatch")
        interface = canonical_json(extracted / "interface-equivalence-report.json")
        migration = canonical_json(extracted / "migration-matrix-report.json")
        if interface.get("schemaVersion") != "jeden.interface-equivalence-report.v1" or interface.get("classification") != "Passed":
            fail("contractual interface equivalence report did not pass")
        fixtures = migration.get("fixtures")
        behaviors = migration.get("behaviors")
        if (migration.get("schemaVersion") != "jeden.migration-matrix-report.v1" or migration.get("classification") != "NotRun" or
                not isinstance(fixtures, list) or not fixtures or any(item.get("classification") != "Passed" for item in fixtures) or
                not isinstance(behaviors, list) or not behaviors or any(item.get("classification") != "NotRun" for item in behaviors)):
            fail("contractual migration matrix report is not the approved fixture contract result")
        gate = {
            "schema": "jeden.release-gate-digests/v1",
            "headSha": sha,
            "contractualCiRunId": ci_run_id,
            "contractualCiRunAttempt": ci_attempt,
            "reports": {
                "interfaceEquivalence": {"name": "interface-equivalence-report.json", "sha256": digest(extracted / "interface-equivalence-report.json")},
                "migrationMatrix": {"name": "migration-matrix-report.json", "sha256": digest(extracted / "migration-matrix-report.json")},
            },
        }
    gate_path = root / "release-gate-digests.json"
    gate_path.write_text(json.dumps(gate, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    gate_path.chmod(0o600)
    return gate


def validate_bundle(root: pathlib.Path, token: str, run_id: int, attempt: int, sha: str) -> None:
    files = [path for path in root.iterdir() if path.is_file()]
    if any(path.is_dir() for path in root.iterdir()):
        fail("release artifact contains unexpected directories")
    archives = [path for path in files if re.fullmatch(r"jeden-[A-Za-z0-9_.-]+\.tar\.gz", path.name)]
    fixed = {"build-handoff.json", "sbom.spdx.json", "provenance.intoto.json"}
    if len(archives) != 1 or {path.name for path in files} != fixed | {archives[0].name}:
        fail("release artifact file allowlist mismatch")

    handoff_path = root / "build-handoff.json"
    sbom_path = root / "sbom.spdx.json"
    provenance_path = root / "provenance.intoto.json"
    handoff = canonical_json(handoff_path)
    exact_keys(handoff, {"schema", "repository", "headSha", "version", "minimumVersion", "createdAt", "contractualCiRunId",
                         "contractualCiRunAttempt", "buildRunId", "buildRunAttempt", "targetTriple", "artifact", "sbom", "provenance"},
               "build handoff")
    if (handoff.get("schema") != "jeden.release-build-handoff/v1" or handoff.get("repository", "").lower() != REPOSITORY.lower() or
            handoff.get("headSha") != sha or handoff.get("buildRunId") != str(run_id) or handoff.get("buildRunAttempt") != attempt):
        fail("build handoff repository, source SHA, or build run mismatch")
    semver = r"[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?"
    if not re.fullmatch(semver, handoff.get("version", "")) or not re.fullmatch(semver, handoff.get("minimumVersion", "")):
        fail("build handoff release version is invalid")
    try:
        created_at = datetime.datetime.fromisoformat(handoff.get("createdAt", "").replace("Z", "+00:00"))
    except (AttributeError, ValueError):
        fail("build handoff creation timestamp is invalid")
    if created_at.tzinfo is None or created_at > datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(minutes=5):
        fail("build handoff creation timestamp is untrusted")
    if not isinstance(handoff.get("targetTriple"), str) or not handoff["targetTriple"] or handoff["targetTriple"] not in archives[0].name:
        fail("build handoff target is invalid or does not bind the archive name")
    ci_run_id = handoff.get("contractualCiRunId", "")
    ci_attempt = handoff.get("contractualCiRunAttempt")
    if not re.fullmatch(r"[1-9][0-9]*", ci_run_id) or not isinstance(ci_attempt, int) or ci_attempt < 1:
        fail("build handoff contractual CI binding is invalid")

    artifact = handoff.get("artifact")
    sbom = handoff.get("sbom")
    provenance = handoff.get("provenance")
    if not all(isinstance(value, dict) for value in (artifact, sbom, provenance)):
        fail("build handoff digest records are missing")
    exact_keys(artifact, {"name", "sha256", "size"}, "artifact digest record")
    exact_keys(sbom, {"name", "sha256"}, "SBOM digest record")
    exact_keys(provenance, {"name", "sha256"}, "provenance digest record")
    archive = archives[0]
    if (artifact.get("name") != archive.name or artifact.get("sha256") != digest(archive) or
            artifact.get("size") != archive.stat().st_size or sbom != {"name": sbom_path.name, "sha256": digest(sbom_path)} or
            provenance != {"name": provenance_path.name, "sha256": digest(provenance_path)}):
        fail("build handoff does not match downloaded bytes")
    json.loads(sbom_path.read_bytes())

    statement = canonical_json(provenance_path)
    subjects = statement.get("subject")
    predicate = statement.get("predicate") or {}
    build = predicate.get("buildDefinition") or {}
    details = predicate.get("runDetails") or {}
    metadata = details.get("metadata") or {}
    builder = details.get("builder") or {}
    dependencies = build.get("resolvedDependencies") or []
    expected_repo = f"git+https://github.com/{REPOSITORY}@{sha}".lower()
    if (not isinstance(subjects, list) or len(subjects) != 1 or subjects[0].get("name") != archive.name or
            (subjects[0].get("digest") or {}).get("sha256") != digest(archive) or
            builder.get("id") != f"https://github.com/{REPOSITORY}/actions/runs/{run_id}" or
            metadata.get("invocationId") != f"{run_id}-{attempt}" or
            not any(isinstance(item, dict) and str(item.get("uri", "")).lower() == expected_repo for item in dependencies)):
        fail("provenance source SHA or workflow run binding mismatch")
    fetch_contract_reports(token, root, ci_run_id, ci_attempt, sha)


def load_state(path: pathlib.Path) -> dict:
    if not path.exists():
        return {"published": []}
    require_owner_only(path, directory=False)
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict) or not isinstance(value.get("published"), list):
        fail("publisher poll state has invalid shape")
    return value


def save_state(path: pathlib.Path, state: dict) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    require_owner_only(path.parent, directory=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def main() -> None:
    skarbiec = pathlib.Path(os.environ.get("SKARBIEC_BIN", pathlib.Path.home() / ".weles-secrets/skarbiec-entitlements-router"))
    vault = pathlib.Path(os.environ.get("SKARBIEC_VAULT_FILE", pathlib.Path.home() / ".weles-secrets/skarbiec.vault.json"))
    publish_state = pathlib.Path(os.environ.get("SKARBIEC_RELEASE_PUBLISH_STATE", pathlib.Path.home() / ".weles-secrets/skarbiec-release-publish-state.sqlite3"))
    audit_dir = pathlib.Path(os.environ.get("SKARBIEC_RELEASE_AUDIT_DIR", pathlib.Path.home() / ".weles-secrets/skarbiec-release-audit"))
    poll_state = pathlib.Path(os.environ.get("SKARBIEC_RELEASE_POLL_STATE", pathlib.Path.home() / ".weles-secrets/skarbiec-release-poller-state.json"))
    if not publish_state.is_absolute() or not audit_dir.is_absolute():
        fail("Skarbiec release publisher paths must be absolute")
    if not skarbiec.is_file() or skarbiec.stat().st_uid != os.getuid() or not os.access(skarbiec, os.X_OK):
        fail("checked Skarbiec binary is unavailable, unowned, or not executable")
    require_owner_only(vault, directory=False)
    require_owner_only(publish_state.parent, directory=True)
    if publish_state.exists():
        require_owner_only(publish_state, directory=False)
    audit_dir.mkdir(mode=0o700, exist_ok=True)
    require_owner_only(audit_dir, directory=True)

    state = load_state(poll_state)
    published = set(state["published"])
    token = github_token()
    runs = api_json(f"/actions/workflows/{WORKFLOW}/runs?branch=main&status=completed&per_page=20", token).get("workflow_runs")
    if not isinstance(runs, list):
        fail("GitHub workflow runs response is invalid")
    candidates = []
    for run in runs:
        repository = run.get("head_repository") or {}
        if (run.get("conclusion") != "success" or run.get("status") != "completed" or run.get("head_branch") != "main" or
                run.get("event") != "workflow_run" or run.get("name") != "Signed canary release" or
                run.get("path") != ".github/workflows/release.yml" or repository.get("full_name", "").lower() != REPOSITORY.lower()):
            continue
        run_id, attempt, sha = run.get("id"), run.get("run_attempt"), run.get("head_sha")
        if not isinstance(run_id, int) or not isinstance(attempt, int) or not isinstance(sha, str) or not SHA_RE.fullmatch(sha):
            fail("successful workflow run has invalid immutable identity")
        identity = f"{run_id}:{attempt}:{sha}"
        if identity not in published:
            candidates.append((run_id, attempt, sha, identity))
    candidates.sort()

    for run_id, attempt, sha, identity in candidates:
        listing = api_json(f"/actions/runs/{run_id}/artifacts?per_page=100", token).get("artifacts")
        if not isinstance(listing, list) or not listing:
            fail(f"run {run_id} has no release artifacts")
        if len(listing) > 32:
            fail(f"run {run_id} has an unexpected artifact count")
        with tempfile.TemporaryDirectory(prefix="skarbiec-release-", dir=str(poll_state.parent)) as temporary:
            stage = pathlib.Path(temporary)
            stage.chmod(0o700)
            for artifact in listing:
                name = artifact.get("name")
                if artifact.get("expired") is not False or not isinstance(name, str) or sha not in name:
                    fail(f"run {run_id} artifact is expired or not bound to its exact SHA")
                artifact_id = artifact.get("id")
                if not isinstance(artifact_id, int) or not re.fullmatch(r"[A-Za-z0-9_.-]+", name):
                    fail(f"run {run_id} artifact metadata is invalid")
                archive = stage / f"{artifact_id}.zip"
                download(f"{API}/actions/artifacts/{artifact_id}/zip", archive, token)
                extract_zip(archive, stage / name)
                archive.unlink()
                validate_bundle(stage / name, token, run_id, attempt, sha)
            environment = os.environ.copy()
            environment["SKARBIEC_VAULT_FILE"] = str(vault)
            environment["SKARBIEC_RELEASE_PUBLISH_STATE"] = str(publish_state)
            environment["SKARBIEC_RELEASE_AUDIT_DIR"] = str(audit_dir)
            environment.pop("GH_TOKEN", None)
            environment.pop("GITHUB_TOKEN", None)
            subprocess.run(
                [str(skarbiec), "release-publish", "--artifact-dir", str(stage), "--repository", REPOSITORY,
                 "--run-id", str(run_id), "--run-attempt", str(attempt), "--sha", sha, "--channel", "canary"],
                env=environment,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                check=True,
            )
        published.add(identity)
        state["published"] = sorted(published)[-200:]
        save_state(poll_state, state)
        print(f"published successful release workflow run {run_id} attempt {attempt} at {sha}")


if __name__ == "__main__":
    main()
