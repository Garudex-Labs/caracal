"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Runs the Lynx Capital Rego policy decision suite through OPA when the binary is available.
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

POLICIES_DIR = Path(__file__).resolve().parent.parent / "policies"


def _opa() -> str | None:
    found = shutil.which("opa")
    if found:
        return found
    fallback = Path("/tmp/opa")
    return str(fallback) if fallback.exists() else None


@pytest.mark.skipif(_opa() is None, reason="opa binary not available")
def test_policy_decision_suite_passes():
    result = subprocess.run(
        [_opa(), "test", str(POLICIES_DIR), "-v"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert "PASS" in result.stdout


@pytest.mark.skipif(_opa() is None, reason="opa binary not available")
def test_policy_library_is_fmt_canonical():
    result = subprocess.run(
        [_opa(), "fmt", "--list", str(POLICIES_DIR)],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "", f"files need `opa fmt`:\n{result.stdout}"


def test_policy_library_matches_the_manifest_base_first():
    manifest = json.loads((POLICIES_DIR / "manifest.json").read_text(encoding="utf-8"))
    files = sorted(p.stem for p in POLICIES_DIR.glob("*.rego"))
    assert files == sorted(manifest["policies"])
    assert manifest["policies"][0] == "00-base"
    assert manifest["policySet"] == "lynx-finance-ops"
    assert {"00-base", "01-bindings", "02-grants", "10-decisions"} == set(manifest["policies"])


def test_every_policy_satisfies_the_authoring_contract():
    contents = {p.stem: p.read_text(encoding="utf-8") for p in POLICIES_DIR.glob("*.rego")}
    for name, content in contents.items():
        assert "package caracal.authz" in content, name
        assert "result" in content, name
    defaults = [name for name, content in contents.items() if "default result" in content]
    assert defaults == ["00-base"], "exactly one default result rule is allowed bundle-wide"
