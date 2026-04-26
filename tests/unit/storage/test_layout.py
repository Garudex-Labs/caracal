"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for CaracalLayout, get_caracal_layout, and ensure_layout in storage/layout.py.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest

from caracal.storage.layout import CaracalLayout, ensure_layout, get_caracal_layout


@pytest.mark.unit
class TestCaracalLayoutProperties:
    def setup_method(self):
        self.root = Path("/tmp/test_home")
        self.layout = CaracalLayout(root=self.root)

    def test_keystore_dir(self):
        assert self.layout.keystore_dir == self.root / "keystore"

    def test_workspaces_dir(self):
        assert self.layout.workspaces_dir == self.root / "workspaces"

    def test_ledger_dir(self):
        assert self.layout.ledger_dir == self.root / "ledger"

    def test_merkle_dir(self):
        assert self.layout.merkle_dir == self.root / "ledger" / "merkle"

    def test_audit_logs_dir(self):
        assert self.layout.audit_logs_dir == self.root / "ledger" / "audit_logs"

    def test_system_dir(self):
        assert self.layout.system_dir == self.root / "system"

    def test_metadata_dir(self):
        assert self.layout.metadata_dir == self.root / "system" / "metadata"

    def test_history_dir(self):
        assert self.layout.history_dir == self.root / "system" / "history"

    def test_root_is_frozen(self):
        with pytest.raises((AttributeError, TypeError)):
            self.layout.root = Path("/other")


@pytest.mark.unit
class TestGetCaracalLayout:
    def test_with_explicit_home(self, tmp_path):
        layout = get_caracal_layout(home=tmp_path)
        assert layout.root == tmp_path.resolve()

    def test_with_string_home(self, tmp_path):
        layout = get_caracal_layout(home=str(tmp_path))
        assert layout.root == tmp_path.resolve()

    def test_without_home_uses_resolve(self, tmp_path):
        with patch("caracal.storage.layout.resolve_caracal_home", return_value=tmp_path):
            layout = get_caracal_layout()
        assert layout.root == tmp_path


@pytest.mark.unit
class TestEnsureLayout:
    def test_creates_all_directories(self, tmp_path):
        layout = CaracalLayout(root=tmp_path / "home")
        ensure_layout(layout)

        assert layout.root.exists()
        assert layout.keystore_dir.exists()
        assert layout.workspaces_dir.exists()
        assert layout.ledger_dir.exists()
        assert layout.merkle_dir.exists()
        assert layout.audit_logs_dir.exists()
        assert layout.system_dir.exists()
        assert layout.metadata_dir.exists()
        assert layout.history_dir.exists()

    def test_idempotent(self, tmp_path):
        layout = CaracalLayout(root=tmp_path / "home")
        ensure_layout(layout)
        ensure_layout(layout)  # second call should not raise

    def test_sets_permissions_700_on_root(self, tmp_path):
        layout = CaracalLayout(root=tmp_path / "home")
        ensure_layout(layout)
        mode = oct(os.stat(layout.root).st_mode & 0o777)
        assert mode == oct(0o700)

    def test_sets_permissions_700_on_keystore(self, tmp_path):
        layout = CaracalLayout(root=tmp_path / "home")
        ensure_layout(layout)
        mode = oct(os.stat(layout.keystore_dir).st_mode & 0o777)
        assert mode == oct(0o700)
