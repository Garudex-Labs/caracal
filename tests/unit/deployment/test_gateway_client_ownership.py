"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for OSS gateway client ownership boundaries.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest


pytestmark = pytest.mark.unit


def test_gateway_client_module_is_not_shipped_in_oss_package() -> None:
    assert importlib.util.find_spec("caracal.deployment.gateway_client") is None


def test_gateway_client_source_is_not_owned_by_oss_package() -> None:
    repo_root = Path(__file__).resolve().parents[3]
    source_path = repo_root / "packages" / "caracal-server" / "caracal" / "deployment" / "gateway_client.py"

    assert not source_path.exists()