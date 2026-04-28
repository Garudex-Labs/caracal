"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for Enterprise Flow import behavior.
"""
from __future__ import annotations

import importlib
import sys
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.unit


def test_enterprise_flow_imports_without_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    module_name = "caracal.flow.screens.enterprise_flow"
    previous_module = sys.modules.pop(module_name, None)
    previous_requests = sys.modules.get("requests")
    monkeypatch.setitem(sys.modules, "requests", None)

    try:
        importlib.import_module(module_name)
    finally:
        sys.modules.pop(module_name, None)
        if previous_module is not None:
            sys.modules[module_name] = previous_module
        if previous_requests is not None:
            sys.modules["requests"] = previous_requests
        else:
            sys.modules.pop("requests", None)


def test_connection_status_handles_missing_requests(monkeypatch: pytest.MonkeyPatch) -> None:
    from caracal.flow.screens import enterprise_flow

    previous_requests = sys.modules.get("requests")
    monkeypatch.setitem(sys.modules, "requests", None)
    monkeypatch.setattr(enterprise_flow, "load_enterprise_config", lambda: {})
    monkeypatch.setattr(enterprise_flow.Prompt, "ask", lambda *args, **kwargs: "")

    flow = enterprise_flow.EnterpriseFlow()
    flow.validator = SimpleNamespace(
        get_license_info=lambda: {
            "license_active": True,
            "tier": "team",
            "license_key": "lic-test",
            "features_available": ["sync"],
            "expires_at": "Never",
            "enterprise_api_url": "https://enterprise.example",
        }
    )

    try:
        flow.show_connection_status()
    finally:
        if previous_requests is not None:
            sys.modules["requests"] = previous_requests
        else:
            sys.modules.pop("requests", None)
