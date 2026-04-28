"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs

Tests for SecretsAdapter and _LocalCaracalVaultBackend.
"""

import pytest
from unittest.mock import MagicMock, patch

from caracal.deployment.secrets_adapter import (
    SecretsAdapter,
    SecretsAdapterError,
    _LocalCaracalVaultBackend,
)

pytestmark = pytest.mark.unit


class TestSecretsAdapterError:
    def test_is_exception(self):
        err = SecretsAdapterError("boom")
        assert isinstance(err, Exception)
        assert str(err) == "boom"


class TestLocalCaracalVaultBackendParseRef:
    def _backend(self):
        return _LocalCaracalVaultBackend(workspace_id="workspace-1")

    def test_parse_valid_ref(self):
        b = self._backend()
        env_id, name = b._parse_ref("caracal:prod/my-secret")
        assert env_id == "prod"
        assert name == "my-secret"

    def test_parse_ref_strips_prefix(self):
        b = self._backend()
        env_id, name = b._parse_ref("caracal:dev/token/nested")
        assert env_id == "dev"
        assert name == "token/nested"

    def test_parse_ref_no_slash_raises(self):
        b = self._backend()
        with pytest.raises(SecretsAdapterError, match="Invalid CaracalVault ref"):
            b._parse_ref("caracal:noseparator")

    def test_name_property(self):
        b = self._backend()
        assert b.name == "caracal_vault"


class TestSecretsAdapterPure:
    def _make_adapter(self):
        mock_backend = MagicMock()
        mock_backend.name = "mock_backend"
        adapter = SecretsAdapter.__new__(SecretsAdapter)
        adapter._workspace_id = "workspace-1"
        adapter._env_id = "default"
        adapter._backend = mock_backend
        return adapter, mock_backend

    def test_ref_for(self):
        adapter, _ = self._make_adapter()
        ref = adapter.ref_for("my-secret")
        assert ref == "caracal:default/my-secret"

    def test_backend_name_property(self):
        adapter, mock = self._make_adapter()
        assert adapter.backend_name == "mock_backend"

    def test_resolve_calls_backend_get(self):
        adapter, mock = self._make_adapter()
        mock.get.return_value = "secret-value"
        result = adapter.resolve("caracal:dev/my-key")
        assert result == "secret-value"
        mock.get.assert_called_once_with("caracal:dev/my-key")

    def test_resolve_empty_ref_raises(self):
        adapter, _ = self._make_adapter()
        with pytest.raises(SecretsAdapterError, match="must not be empty"):
            adapter.resolve("")

    def test_resolve_backend_error_raises(self):
        adapter, mock = self._make_adapter()
        mock.get.side_effect = RuntimeError("conn failed")
        with pytest.raises(SecretsAdapterError, match="Failed to resolve"):
            adapter.resolve("caracal:dev/key")

    def test_store_calls_backend_put(self):
        adapter, mock = self._make_adapter()
        adapter.store("caracal:dev/key", "value")
        mock.put.assert_called_once_with("caracal:dev/key", "value")

    def test_store_empty_ref_raises(self):
        adapter, _ = self._make_adapter()
        with pytest.raises(SecretsAdapterError, match="must not be empty"):
            adapter.store("", "value")

    def test_store_empty_value_raises(self):
        adapter, _ = self._make_adapter()
        with pytest.raises(SecretsAdapterError, match="must not be empty"):
            adapter.store("caracal:dev/key", "")

    def test_store_backend_error_raises(self):
        adapter, mock = self._make_adapter()
        mock.put.side_effect = RuntimeError("write failed")
        with pytest.raises(SecretsAdapterError, match="Failed to store"):
            adapter.store("caracal:dev/key", "val")

    def test_delete_calls_backend_delete(self):
        adapter, mock = self._make_adapter()
        adapter.delete("caracal:dev/old-key")
        mock.delete.assert_called_once_with("caracal:dev/old-key")

    def test_delete_backend_error_raises(self):
        adapter, mock = self._make_adapter()
        mock.delete.side_effect = RuntimeError("gone")
        with pytest.raises(SecretsAdapterError, match="Failed to delete"):
            adapter.delete("caracal:dev/key")

    def test_list_refs_calls_backend(self):
        adapter, mock = self._make_adapter()
        mock.list_refs.return_value = ["ref-a", "ref-b"]
        result = adapter.list_refs()
        assert result == ["ref-a", "ref-b"]

    def test_list_refs_error_raises(self):
        adapter, mock = self._make_adapter()
        mock.list_refs.side_effect = RuntimeError("query failed")
        with pytest.raises(SecretsAdapterError, match="Failed to list"):
            adapter.list_refs()


class TestSecretsAdapterCreatesVaultBackend:
    def test_creates_local_vault_backend(self):
        adapter = SecretsAdapter(workspace_id="workspace-1", env_id="default")

        assert isinstance(adapter._backend, _LocalCaracalVaultBackend)
        assert adapter.backend_name == "caracal_vault"
