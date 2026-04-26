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

    def test_ccl_env_set_to_test(self) -> None:
        assert os.environ.get("CCL_ENV") == "test"

    def test_log_level_set_to_error(self) -> None:
        assert os.environ.get("CCL_LOG_LEVEL") == "ERROR"

    def test_unknown_mode_env_does_not_crash_import(self, monkeypatch) -> None:
        monkeypatch.setenv("CCL_MODE", "unknown-mode-xyz")
        from caracal.deployment.mode import ModeManager

        manager = ModeManager()
        manager.clear_cache()

    def test_missing_db_url_env_does_not_crash_import(self, monkeypatch) -> None:
        monkeypatch.delenv("CCL_TEST_DB_URL", raising=False)
        assert os.environ.get("CCL_TEST_DB_URL") is None
