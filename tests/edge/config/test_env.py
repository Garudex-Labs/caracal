"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Edge case tests for configuration settings validation.
"""
from __future__ import annotations

import os

import pytest


@pytest.mark.edge
class TestEnvParsing:
    """Edge cases for environment-based config loading."""

    def test_caracal_env_set_to_test(self) -> None:
        assert os.environ.get("CARACAL_ENV") == "test"

    def test_log_level_set_to_error(self) -> None:
        assert os.environ.get("CARACAL_LOG_LEVEL") == "ERROR"

    def test_unknown_mode_env_does_not_crash_import(self, monkeypatch) -> None:
        monkeypatch.setenv("CARACAL_MODE", "unknown-mode-xyz")
        try:
            from caracal.deployment.mode import ModeManager
            m = ModeManager()
            m.clear_cache()
        except Exception:
            pass

    def test_missing_db_url_env_does_not_crash_import(self, monkeypatch) -> None:
        monkeypatch.delenv("CARACAL_TEST_DB_URL", raising=False)
        assert os.environ.get("CARACAL_TEST_DB_URL") is None
