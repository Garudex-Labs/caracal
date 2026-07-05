"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Runs the Lynx Capital authorization data against the platform decision contract through OPA when the binary is available.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

POLICIES_DIR = Path(__file__).resolve().parent.parent / "policies"
REPO_ROOT = Path(__file__).resolve().parents[3]
DECISION_CONTRACT = (
    REPO_ROOT / "services" / "sts" / "internal" / "decision_contract.rego"
)


def _opa() -> str | None:
    found = shutil.which("opa")
    if found:
        return found
    fallback = Path("/tmp/opa")
    return str(fallback) if fallback.exists() else None


@pytest.mark.skipif(_opa() is None, reason="opa binary not available")
def test_policy_decision_suite_passes():
    result = subprocess.run(
        [_opa(), "test", str(POLICIES_DIR), str(DECISION_CONTRACT), "-v"],
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


def test_policy_library_matches_the_manifest():
    manifest = json.loads((POLICIES_DIR / "manifest.json").read_text(encoding="utf-8"))
    files = sorted(p.stem for p in POLICIES_DIR.glob("*.rego"))
    assert files == sorted(manifest["policies"])
    assert manifest["policySet"] == "lynx-finance-ops"
    assert {"01-bindings", "02-grants", "03-confinement"} == set(manifest["policies"])


def test_every_policy_is_a_data_document():
    contents = {
        p.stem: p.read_text(encoding="utf-8") for p in POLICIES_DIR.glob("*.rego")
    }
    for name, content in contents.items():
        assert "package caracal.authz" in content, name
        assert "# caracal:data-document" in content, name
        assert "result :=" not in content, name
        assert "default result" not in content, name
