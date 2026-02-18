"""
Copyright (C) 2026 Garudex Labs.  All Rights Reserved.
Caracal, a product of Garudex Labs


"""


import json
import os
from pathlib import Path
from unittest.mock import patch, mock_open

import pytest

from caracal.flow.workspace import (
    WorkspaceManager,
    get_workspace,
    set_workspace,
    _DEFAULT_ROOT,
    _REGISTRY_PATH,
)

@pytest.fixture
def temp_workspace(tmp_path):
    """Fixture to provide a temporary workspace root."""
    return tmp_path / "custom_workspace"

class TestWorkspaceManager:
    def test_default_init(self):
        """Test initialization with default root."""
        wm = WorkspaceManager()
        assert wm.root == _DEFAULT_ROOT
        assert wm.config_path == _DEFAULT_ROOT / "config.yaml"

    def test_custom_init(self, temp_workspace):
        """Test initialization with custom root."""
        wm = WorkspaceManager(temp_workspace)
        assert wm.root == temp_workspace
        assert wm.config_path == temp_workspace / "config.yaml"
        assert wm.state_path == temp_workspace / "flow_state.json"
        assert wm.db_path == temp_workspace / "caracal.db"
        assert wm.backups_dir == temp_workspace / "backups"
        assert wm.log_path == temp_workspace / "caracal.log"
        assert wm.agents_path == temp_workspace / "agents.json"
        assert wm.policies_path == temp_workspace / "policies.json"
        assert wm.ledger_path == temp_workspace / "ledger.jsonl"
        assert wm.master_password_path == temp_workspace / "master_password"

    def test_ensure_dirs(self, temp_workspace):
        """Test directory creation."""
        wm = WorkspaceManager(temp_workspace)
        wm.ensure_dirs()
        assert temp_workspace.exists()
        assert wm.backups_dir.exists()

    def test_repr(self, temp_workspace):
        """Test string representation."""
        wm = WorkspaceManager(temp_workspace)
        assert f"root={temp_workspace!r}" in repr(wm)

class TestGlobalState:
    def setup_method(self):
        # Reset global state before each test
        import caracal.flow.workspace
        caracal.flow.workspace._current_workspace = None

    def teardown_method(self):
        # Reset global state after each test
        import caracal.flow.workspace
        caracal.flow.workspace._current_workspace = None

    def test_get_workspace_defaults(self):
        """Test get_workspace returns default if not set."""
        wm = get_workspace()
        assert wm.root == _DEFAULT_ROOT
        # Subsequent call returns same instance
        assert get_workspace() is wm

    def test_get_workspace_with_path(self, temp_workspace):
        """Test get_workspace creates new instance if path provided."""
        wm1 = get_workspace(temp_workspace)
        assert wm1.root == temp_workspace
        
        # Passing path always returns new instance
        wm2 = get_workspace(temp_workspace)
        assert wm1 is not wm2

    def test_set_workspace(self, temp_workspace):
        """Test set_workspace updates global state."""
        wm = set_workspace(temp_workspace)
        assert wm.root == temp_workspace
        
        # get_workspace() should return the set instance
        global_wm = get_workspace()
        assert global_wm.root == temp_workspace
        assert global_wm is wm

class TestRegistry:
    def test_list_workspaces_empty(self, tmp_path):
        """Test listing workspaces when registry file doesn't exist."""
        registry_path = tmp_path / "workspaces.json"
        assert WorkspaceManager.list_workspaces(registry_path) == []

    def test_register_and_list_workspace(self, tmp_path):
        """Test registering and listing workspaces."""
        registry_path = tmp_path / "workspaces.json"
        
        WorkspaceManager.register_workspace(
            name="Test WS", 
            path="/tmp/test", 
            registry_path=registry_path
        )
        
        workspaces = WorkspaceManager.list_workspaces(registry_path)
        assert len(workspaces) == 1
        assert workspaces[0]["name"] == "Test WS"
        assert workspaces[0]["path"] == "/tmp/test"

    def test_register_duplicate(self, tmp_path):
        """Test that duplicate paths are skipped."""
        registry_path = tmp_path / "workspaces.json"
        
        path = Path("/tmp/test").resolve()
        
        WorkspaceManager.register_workspace(
            name="WS 1", 
            path=path, 
            registry_path=registry_path
        )
        
        # Try to register same path with different name
        WorkspaceManager.register_workspace(
            name="WS 2", 
            path=str(path), # mixed types checks
            registry_path=registry_path
        )
        
        workspaces = WorkspaceManager.list_workspaces(registry_path)
        assert len(workspaces) == 1
        assert workspaces[0]["name"] == "WS 1"

    def test_register_append(self, tmp_path):
        """Test appending new workspace to existing registry."""
        registry_path = tmp_path / "workspaces.json"
        
        WorkspaceManager.register_workspace("WS 1", "/tmp/1", registry_path)
        WorkspaceManager.register_workspace("WS 2", "/tmp/2", registry_path)
        
        workspaces = WorkspaceManager.list_workspaces(registry_path)
        assert len(workspaces) == 2
        assert workspaces[0]["name"] == "WS 1"
        assert workspaces[1]["name"] == "WS 2"

if __name__ == "__main__":
    pytest.main(["-v", "-s", __file__])
