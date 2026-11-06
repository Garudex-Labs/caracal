#!/usr/bin/env python3
# Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
# Caracal, a product of Garudex Labs
#
# Checks hash-locked Python tooling against its inputs and package metadata.

import re
import sys
import tomllib
from pathlib import Path

from packaging.requirements import Requirement
from packaging.utils import canonicalize_name
from packaging.version import Version

ROOT = Path(__file__).resolve().parent.parent


def read_lock(text):
    """Reject unpinned, unhashed, duplicate, or unexpected lock entries."""
    locked = {}
    for block in text.replace("\\\n", " ").splitlines():
        block = block.split("#", 1)[0].strip()
        if not block:
            continue
        requirement, *hashes = block.split(" --hash=")
        req = Requirement(requirement.strip())
        pins = list(req.specifier)
        if (
            req.url
            or req.marker
            or req.extras
            or len(pins) != 1
            or pins[0].operator != "=="
            or "*" in pins[0].version
        ):
            raise ValueError(f"{req.name}: lock entries must be exact version pins")
        if not hashes or any(
            not re.fullmatch(r"sha256:[a-f0-9]{64}", h.strip()) for h in hashes
        ):
            raise ValueError(f"{req.name}: missing or malformed SHA256 hashes")
        name = canonicalize_name(req.name)
        if name in locked:
            raise ValueError(f"{req.name}: duplicate lock entry")
        locked[name] = Version(pins[0].version)
    return locked


def check_requirements(requirements, locked, context):
    findings = []
    for value in requirements:
        req = Requirement(value)
        if req.marker and not req.marker.evaluate():
            continue
        name = canonicalize_name(req.name)
        if name.startswith("caracalai-"):
            continue  # Intra-repository versions are checked by release tooling.
        version = locked.get(name)
        if version is None or version not in req.specifier:
            findings.append(f"{context}: {req} is not satisfied by locked {version}")
    return findings


def validate(root=ROOT):
    findings = []
    locks = {}
    for path in sorted((root / "scripts").glob("*Requirements.lock")):
        try:
            locked = read_lock(path.read_text())
            locks[path.stem] = locked
            inputs = [
                line.split("#", 1)[0].strip()
                for line in path.with_suffix(".in").read_text().splitlines()
            ]
            findings.extend(
                check_requirements([line for line in inputs if line], locked, path.name)
            )
        except (ValueError, OSError) as error:
            findings.append(f"{path.name}: {error}")
    test_lock = locks.get("pythonTestRequirements", {})
    publish_lock = locks.get("publishPypiRequirements", {})
    for path in sorted((root / "packages").rglob("pyproject.toml")):
        metadata = tomllib.loads(path.read_text())
        context = str(path.relative_to(root))
        findings.extend(
            check_requirements(
                metadata.get("project", {}).get("dependencies", []), test_lock, context
            )
        )
        backend = metadata.get("build-system", {}).get("requires", [])
        findings.extend(
            check_requirements(backend, test_lock, context + " test backend")
        )
        findings.extend(
            check_requirements(backend, publish_lock, context + " release backend")
        )
    return findings


if __name__ == "__main__":
    errors = validate()
    for error in errors:
        print(error, file=sys.stderr)
    if errors:
        sys.exit(1)
    print("Python dependency pins, hashes, and package constraints are consistent")
