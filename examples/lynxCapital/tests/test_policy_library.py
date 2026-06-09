"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Runs the Lynx Capital Rego policy decision suite through OPA when the binary is available.
"""
from __future__ import annotations

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


def test_policy_library_is_complete_and_base_first():
    files = sorted(p.name for p in POLICIES_DIR.glob("*.rego"))
    assert files[0] == "00-base.rego"
    for required in (
        "portfolio-read.rego",
        "portfolio-write.rego",
        "portfolio-admin.rego",
        "research-read.rego",
        "research-write.rego",
        "compliance-review.rego",
        "compliance-admin.rego",
        "customer-admin.rego",
        "auditor.rego",
        "delegated-advisor.rego",
        "emergency-access.rego",
    ):
        assert required in files
    for path in POLICIES_DIR.glob("*.rego"):
        assert "package caracal.authz" in path.read_text(encoding="utf-8")
