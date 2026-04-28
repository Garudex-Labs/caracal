"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Unit tests for Enterprise Flow import behavior.
"""
from __future__ import annotations

import importlib
import sys


def test_enterprise_flow_imports_without_requests(monkeypatch):
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
