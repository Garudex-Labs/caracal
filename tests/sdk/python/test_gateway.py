"""Regression tests for SDK gateway fallback behavior."""

from __future__ import annotations

import builtins
import importlib
import sys

import pytest

import caracal_sdk.gateway as gateway_module


@pytest.mark.unit
def test_gateway_module_propagates_unexpected_gateway_feature_import_failures(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_import = builtins.__import__

    def _patched_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "caracal.core.gateway_features":
            raise RuntimeError("gateway feature import exploded")
        return original_import(name, globals, locals, fromlist, level)

    with monkeypatch.context() as local_patch:
        local_patch.setattr(builtins, "__import__", _patched_import)
        importlib.reload(gateway_module)
        sys.modules.pop("caracal.core.gateway_features", None)
        with pytest.raises(RuntimeError, match="gateway feature import exploded"):
            gateway_module.get_gateway_features()

    importlib.reload(gateway_module)


@pytest.mark.unit
def test_gateway_module_keeps_importerror_fallback_for_optional_core_dependency(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    original_import = builtins.__import__

    def _patched_import(name, globals=None, locals=None, fromlist=(), level=0):
        if name == "caracal.core.gateway_features":
            raise ImportError("core package unavailable")
        return original_import(name, globals, locals, fromlist, level)

    with monkeypatch.context() as local_patch:
        local_patch.setattr(builtins, "__import__", _patched_import)
        reloaded = importlib.reload(gateway_module)
        sys.modules.pop("caracal.core.gateway_features", None)
        flags = reloaded.get_gateway_features()

    importlib.reload(gateway_module)

    assert reloaded.GatewayFeatureFlags is not None
    assert flags.deployment_type in {"oss", "enterprise", "managed", "on_prem"}
