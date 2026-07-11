"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Verifies published PyPI files against PyPI and GitHub provenance.
"""

import json
import hashlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

REPOSITORY = "Garudex-Labs/caracal"
REPOSITORY_URL = f"https://github.com/{REPOSITORY}"


def request_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "Cache-Control": "no-cache", "Pragma": "no-cache"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


def release_files(name: str, version: str, timeout: int = 300) -> list[dict]:
    deadline = time.monotonic() + timeout
    while True:
        try:
            files = request_json(f"https://pypi.org/pypi/{name}/json").get("releases", {}).get(version, [])
        except urllib.error.URLError:
            files = []
        if files:
            return files
        if time.monotonic() >= deadline:
            raise RuntimeError(f"{name}=={version} is missing from PyPI")
        time.sleep(15)


def verify_github_provenance(path: Path, source_sha: str, release_tag: str) -> None:
    output = subprocess.check_output(
        ["gh", "attestation", "verify", str(path), "--repo", REPOSITORY, "--format", "json"],
        text=True,
    )
    results = json.loads(output)
    for result in results:
        certificate = result.get("verificationResult", {}).get("signature", {}).get("certificate", {})
        if (
            certificate.get("sourceRepositoryDigest") == source_sha
            and certificate.get("sourceRepositoryRef") == f"refs/tags/{release_tag}"
            and certificate.get("sourceRepositoryURI") == REPOSITORY_URL
        ):
            return
    raise RuntimeError(f"{path.name} has no GitHub provenance for {release_tag} at {source_sha}")


def verify_file(file: dict, source_sha: str, release_tag: str, directory: Path) -> None:
    filename = file["filename"]
    url = file["url"]
    subprocess.run(
        ["pypi-attestations", "verify", "pypi", "--repository", REPOSITORY_URL, url],
        check=True,
    )
    path = directory / filename
    urllib.request.urlretrieve(url, path)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if digest != file.get("digests", {}).get("sha256"):
        raise RuntimeError(f"{filename} SHA-256 does not match PyPI metadata")
    verify_github_provenance(path, source_sha, release_tag)
    print(f"{filename} has verified PyPI and GitHub provenance")


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit("usage: verifyPypiRelease.py <package> <version> <source-sha> <release-tag>")
    name, version, source_sha, release_tag = sys.argv[1:]
    if len(source_sha) != 40 or any(character not in "0123456789abcdef" for character in source_sha):
        raise SystemExit(f"invalid source commit: {source_sha}")
    with tempfile.TemporaryDirectory(prefix="caracal-pypi-") as directory:
        for file in release_files(name, version):
            verify_file(file, source_sha, release_tag, Path(directory))
    print(f"{name}=={version} is published with verified provenance")


if __name__ == "__main__":
    main()
